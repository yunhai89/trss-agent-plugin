#!/usr/bin/env bash
# =============================================================================
# E2B Embed（自托管沙箱）一键部署 —— 供 agents-plugin 的 terminal / toolEvo 执行面使用
#
# 做什么：
#   ① preflight 硬前提检查（KVM / 嵌套虚拟化 / 内存 / 磁盘 / 页大小 / 端口 / 发行版）
#   ② 按需装 docker（无则自动安装，apt/dnf/yum/apk 自适应）+ 基础依赖
#   ③ 克隆官方 e2b-dev/runtime（可锁 tag）→ embed/compose 起栈（宿主准备由官方脚本负责）
#   ④ 跑官方 smoke 自检 → 导出 sdk.env 三要素
#   ⑤ 打印可直接粘贴的插件配置，并可选 --write-config 直接写进插件 config.yaml
#
# 用法：
#   scripts/install-e2b-selfhost.sh --check          # 只做前提检查（可在任意机器上先跑）
#   scripts/install-e2b-selfhost.sh                  # 交互式安装（关键步骤会确认）
#   scripts/install-e2b-selfhost.sh -y               # 无人值守安装
#   scripts/install-e2b-selfhost.sh -y --write-config # 装完顺手写进插件配置
#   scripts/install-e2b-selfhost.sh --uninstall      # 卸载（compose down + 官方 teardown）
#
# 环境变量：
#   E2B_REF=<tag/commit>   锁定 e2b-dev/runtime 版本（默认 main；生产建议锁 CalVer tag，如 2026.30）
#   E2B_DIR=<path>         克隆目录（默认 /opt/e2b-runtime）
#   PF_MIN_FREE_GIB=<n>    宿主需保留的最小空闲内存 GiB（默认 20，与官方 PF_MIN_FREE_GIB 对齐）
#   MIN_DISK_GIB=<n>       最小空闲磁盘 GiB（默认 30）
#   SKIP_SMOKE=1           跳过官方 smoke 容器自检（不建议）
#
# 退出码：0 成功 / 1 preflight 不满足 / 2 安装过程失败
#
# ⚠️ 前提是**硬件**：E2B 每个沙箱是一台 Firecracker microVM，必须有 KVM。
#    没有 /dev/kvm 的机器（绝大多数云主机/容器/嵌套虚拟化未开启的 VM）**无法部署**，
#    本脚本会在 preflight 阶段明确拒绝，不会"装一半"。
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib-ensure-docker.sh
. "$SCRIPT_DIR/lib-ensure-docker.sh"

E2B_REPO="https://github.com/e2b-dev/runtime.git"
E2B_REF="${E2B_REF:-main}"
E2B_DIR="${E2B_DIR:-/opt/e2b-runtime}"
PF_MIN_FREE_GIB="${PF_MIN_FREE_GIB:-20}"
MIN_DISK_GIB="${MIN_DISK_GIB:-30}"
COMPOSE_DIR=""

CHECK_ONLY=0
ASSUME_YES=0
WRITE_CONFIG=0
UNINSTALL=0

# ── 输出小工具（带颜色，非 TTY 自动降级）──
if [ -t 1 ]; then C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_DIM=$'\033[2m'; C_END=$'\033[0m'; else C_OK=; C_WARN=; C_ERR=; C_DIM=; C_END=; fi
log()  { printf '%s\n' "$*"; }
ok()   { printf '%s✓%s %s\n' "$C_OK" "$C_END" "$*"; }
warn() { printf '%s!%s %s\n' "$C_WARN" "$C_END" "$*"; }
die()  { printf '%s✗%s %s\n' "$C_ERR" "$C_END" "$*" >&2; exit "${2:-1}"; }
step() { printf '\n%s== %s ==%s\n' "$C_DIM" "$*" "$C_END"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK_ONLY=1 ;;
    -y|--yes) ASSUME_YES=1 ;;
    --write-config) WRITE_CONFIG=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help) sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "未知参数：$1（--help 看用法）" ;;
  esac
  shift
done

confirm() {
  [ "$ASSUME_YES" = 1 ] && return 0
  printf '%s [y/N] ' "$1"
  read -r a
  case "$a" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# =============================================================================
# ① preflight：把"装了也跑不起来"的情况挡在动手之前
# =============================================================================
preflight() {
  step "前置检查（E2B Embed 硬前提）"
  local fails=0

  # root：要装包、写 /etc、加载内核模块
  if [ "$(id -u)" != "0" ]; then
    warn "非 root：安装需要 root（sudo 重跑或切 root）"; fails=$((fails+1))
  else ok "以 root 运行"; fi

  # 架构：官方支持 x86-64 / arm64
  local arch; arch="$(uname -m)"
  case "$arch" in
    x86_64|aarch64) ok "架构 $arch（官方支持）" ;;
    *) warn "架构 $arch 不在官方支持范围（x86-64 / arm64）"; fails=$((fails+1)) ;;
  esac

  # 发行版：官方不支持 macOS/Windows 宿主与 Container-Optimized OS
  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    case "${ID:-}" in
      ubuntu|debian) ok "发行版 ${PRETTY_NAME:-$ID}" ;;
      cos|*) if [ "${ID:-}" = "cos" ]; then warn "Container-Optimized OS 不受官方支持"; fails=$((fails+1)); else warn "发行版 ${ID:-未知}：官方以 Ubuntu/Debian 验证，其它发行版需自行确认依赖"; fi ;;
    esac
  else warn "读不到 /etc/os-release，无法判断发行版"; fi

  # glibc ≥ 2.34（官方要求）
  if command -v ldd >/dev/null 2>&1; then
    local glibc; glibc="$(ldd --version 2>/dev/null | awk 'NR==1{print $NF}')"
    if [ -n "$glibc" ] && [ "$(printf '%s\n2.34\n' "$glibc" | sort -V | head -1)" = "2.34" ]; then ok "glibc $glibc（≥2.34）"; else warn "glibc ${glibc:-未知} < 2.34，官方不支持"; fails=$((fails+1)); fi
  fi

  # 页大小：要求 4 KiB（Ubuntu 默认满足；16K/64K 页内核不行）
  local pagesize; pagesize="$(getconf PAGESIZE 2>/dev/null || echo 0)"
  if [ "$pagesize" = "4096" ]; then ok "页大小 4 KiB"; else warn "页大小 ${pagesize}B ≠ 4 KiB，官方要求 4 KiB 页内核"; fails=$((fails+1)); fi

  # ── KVM：这一条是决定性的 ──
  if [ -e /dev/kvm ]; then
    if [ -r /dev/kvm ] && [ -w /dev/kvm ]; then ok "/dev/kvm 存在且可读写"; else warn "/dev/kvm 存在但当前用户不可读写"; fails=$((fails+1)); fi
  else
    warn "/dev/kvm 不存在 —— 无法创建 Firecracker microVM"
    if grep -qm1 -E 'vmx|svm' /proc/cpuinfo 2>/dev/null; then
      log "  ${C_DIM}→ CPU 支持虚拟化但设备未暴露：请确认已在 BIOS/宿主开启 VT-x/AMD-V，或（云主机）开启嵌套虚拟化并换到支持 KVM 的实例规格${C_END}"
    else
      log "  ${C_DIM}→ CPU 未向本机暴露虚拟化扩展：这通常说明本机自己就是虚拟机且未开嵌套虚拟化${C_END}"
      log "  ${C_DIM}→ 云厂商常见做法：改用「裸金属 / 支持嵌套虚拟化」的实例规格（阿里云需提交工单开启嵌套虚拟化），再重跑本脚本${C_END}"
      log "  ${C_DIM}→ 若无法满足：请改用 E2B 云托管（只填 apiKey），或把本栈部署到一台真机/裸金属上${C_END}"
    fi
    fails=$((fails+1))
  fi

  # 内存：官方 embed 会保留大块内存给沙箱（PF_MIN_FREE_GIB）
  local free_gib
  free_gib="$(awk '/MemAvailable/{printf "%d", $2/1024/1024}' /proc/meminfo 2>/dev/null || echo 0)"
  if [ "$free_gib" -ge "$PF_MIN_FREE_GIB" ]; then ok "可用内存 ${free_gib} GiB（≥${PF_MIN_FREE_GIB}）"; else warn "可用内存 ${free_gib} GiB < ${PF_MIN_FREE_GIB} GiB：官方 embed 需为沙箱预留（可调 PF_MIN_FREE_GIB，但过小会让沙箱起不来）"; fails=$((fails+1)); fi

  # 磁盘：镜像 + Firecracker + 内核 + 模板
  local free_disk
  free_disk="$(df -Pk / | awk 'NR==2{printf "%d", $4/1024/1024}')"
  if [ "$free_disk" -ge "$MIN_DISK_GIB" ]; then ok "根分区可用磁盘 ${free_disk} GiB（≥${MIN_DISK_GIB}）"; else warn "根分区可用磁盘 ${free_disk} GiB < ${MIN_DISK_GIB} GiB"; fails=$((fails+1)) ; fi

  # 端口：控制面 3000 / 数据面 client-proxy 3002
  local busy=""
  if command -v ss >/dev/null 2>&1; then
    for p in 3000 3002; do ss -tln 2>/dev/null | grep -qE "[:.]$p\b" && busy="$busy $p"; done
    if [ -n "$busy" ]; then warn "端口被占用：$busy（E2B 控制面/数据面需要 3000 与 3002）"; fails=$((fails+1)); else ok "端口 3000 / 3002 空闲"; fi
  else warn "无 ss 命令，跳过端口检查"; fi

  # 工具链
  local need=""
  for c in git curl; do command -v "$c" >/dev/null 2>&1 || need="$need $c"; done
  if command -v apt-get >/dev/null 2>&1; then ok "apt-get 可用（依赖可自动安装）"; else warn "无 apt-get：请自行安装 docker（含 compose v2）、git、curl、make、qemu-kvm 等依赖"; fi
  [ -n "$need" ] && warn "缺少基础命令：$need（安装阶段会尝试用 apt 补齐）"

  if [ "$fails" -gt 0 ]; then
    printf '\n'
    die "前置检查未通过（$fails 项）。E2B Embed 依赖 KVM 硬件隔离，条件不满足时无法部署——请先解决上面的 ✗/! 项，或用 E2B 云托管。" 1
  fi
  ok "前置检查全部通过"
}

# =============================================================================
# ② 依赖：docker（含 compose v2）+ 基础工具
# =============================================================================
install_deps() {
  step "安装依赖（docker / git / make / qemu-kvm…）"
  # docker + compose v2：缺失则按发行版自动安装并启动（共享 lib-ensure-docker.sh，
  # 与 install-kroki.sh 同一实现；-y 时 DOCKER_ASSUME_YES 透传跳过确认）
  DOCKER_ASSUME_YES="$ASSUME_YES" ensure_docker \
    || die "docker 不可用：请手动安装 docker + compose v2 后重跑（或 DOCKER_AUTO_INSTALL=0 关闭自动安装）" 2
  ok "docker 依赖就绪（compose：$DOCKER_COMPOSE）"

  # 其余基础依赖（docker 已由 ensure_docker 处理，这里不重复）
  local pkgs="git make curl ca-certificates qemu-kvm"
  if command -v apt-get >/dev/null 2>&1; then
    confirm "将用 apt 安装：$pkgs（会改动系统包与 /etc）" || die "已取消" 2
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    # shellcheck disable=SC2086
    apt-get install -y $pkgs
    ok "基础依赖安装完成"
  else
    local miss=""
    for c in git curl make; do command -v "$c" >/dev/null 2>&1 || miss="$miss $c"; done
    [ -n "$miss" ] && warn "无 apt-get，请自行确保已安装：$miss 以及 qemu-kvm"
  fi
}

# =============================================================================
# ③ 拉栈 + 起栈（宿主准备交给官方脚本，不自造内核改动）
# =============================================================================
install_e2b() {
  step "拉取 e2b-dev/runtime（ref=${E2B_REF}）到 ${E2B_DIR}"
  if [ -d "$E2B_DIR/.git" ]; then
    ok "目录已存在，复用并拉取更新"
    git -C "$E2B_DIR" fetch --depth 1 origin "$E2B_REF" && git -C "$E2B_DIR" checkout -q FETCH_HEAD
  else
    git clone --depth 1 --branch "$E2B_REF" "$E2B_REPO" "$E2B_DIR" || die "克隆失败（网络/代理/ref 不存在？）" 2
  fi
  COMPOSE_DIR="$E2B_DIR/embed/compose"
  [ -d "$COMPOSE_DIR" ] || die "未找到 ${COMPOSE_DIR}：上游目录结构可能变了，请对照官方 embed/README" 2
  ok "栈目录：$COMPOSE_DIR"

  # 宿主准备（hugepages / nbd / 系统参数）：官方脚本，幂等
  local host_setup="$COMPOSE_DIR/scripts/host-setup.sh"
  if [ -x "$host_setup" ] || [ -f "$host_setup" ]; then
    step "宿主准备（官方 host-setup.sh：hugepages / nbd / sysctl）"
    confirm "将执行官方宿主准备脚本（修改内核参数与模块，用官方 teardown 可逆）" || die "已取消" 2
    bash "$host_setup" || die "host-setup.sh 执行失败（看上面输出；KVM/权限/内核参数常见）" 2
    ok "宿主准备完成"
  else
    warn "未找到 scripts/host-setup.sh：跳过（请确认你的发行版是否需要手工准备 hugepages/nbd）"
  fi

  step "启动 E2B 栈（docker compose up -d --wait）"
  ( cd "$COMPOSE_DIR" && docker compose up -d --wait ) || die "compose 启动失败：docker compose logs 看单个服务" 2
  ok "栈已启动"
}

# =============================================================================
# ④ 自检 + 导出接入三要素
# =============================================================================
verify_and_export() {
  step "官方 smoke 自检"
  if [ "${SKIP_SMOKE:-0}" = "1" ]; then
    warn "SKIP_SMOKE=1：跳过 smoke 自检（不建议，等于没验证栈可用）"
  else
    ( cd "$COMPOSE_DIR" && docker compose --profile test run --rm smoke ) || die "smoke 自检失败：栈起来了但沙箱跑不通，先别接插件（看 smoke 输出定位）" 2
    ok "smoke 自检通过（沙箱可创建 + SDK 可用）"
  fi

  step "导出 SDK 接入三要素"
  local envfile
  envfile="$( ( cd "$COMPOSE_DIR" && docker compose exec -T ready cat /run/e2b/sdk.env ) )" || die "读取 sdk.env 失败（ready 容器没起来？）" 2
  # shellcheck disable=SC1090
  eval "$envfile"
  [ -n "${E2B_API_KEY:-}" ] || die "sdk.env 里没有 E2B_API_KEY" 2
  ok "E2B_API_URL   = ${E2B_API_URL:-}"
  ok "E2B_SANDBOX_URL = ${E2B_SANDBOX_URL:-}"
  ok "E2B_API_KEY   = （已读取，长度 ${#E2B_API_KEY}，不打印明文）"

  # 连通性实证：用控制面直接创建一个沙箱（官方文档 §3.3 的 curl 验证）
  step "连通性实证（控制面创建沙箱）"
  local resp
  resp="$(curl -sS -m 30 -X POST "${E2B_API_URL%/}/sandboxes" \
      -H "X-API-Key: ${E2B_API_KEY}" -H 'Content-Type: application/json' \
      -d '{"templateID":"base","timeout":60}' || true)"
  case "$resp" in
    *sandboxID*) ok "控制面可用（已创建并将在 TTL 后自动回收）" ;;
    *) warn "创建沙箱未返回 sandboxID，响应片段：$(printf '%s' "$resp" | head -c 200)"; warn "栈可能仍在初始化，稍后用 smoke 或插件集成测试复核" ;;
  esac

  step "写入插件配置"
  if [ "$WRITE_CONFIG" = "1" ]; then
    write_plugin_config
  else
    log "把下面这段填进插件「E2B 沙箱」面板（或 config.yaml 的 agent.sandbox）："
    cat <<YAML
  sandbox:
    mode: e2b
    apiKey: "${E2B_API_KEY}"
    apiUrl: "${E2B_API_URL:-}"
    sandboxUrl: "${E2B_SANDBOX_URL:-}"
    template: base
YAML
    log "${C_DIM}（自托管无通配 DNS 时 sandboxUrl 必须填，SDK 会据此附加路由头）${C_END}"
    log "或重跑：$0 -y --write-config"
  fi
}

# 直接改插件 config.yaml：用仓库自带 yaml 库解析（不手写字符串），并先备份
write_plugin_config() {
  local plugin_dir
  plugin_dir="$(cd "$(dirname "$0")/.." && pwd)"
  local cfg="$plugin_dir/config/config.yaml"
  [ -f "$cfg" ] || die "未找到插件配置：$cfg" 2
  cp "$cfg" "$cfg.bak.$(date +%Y%m%d%H%M%S)"
  E2B_KEY="$E2B_API_KEY" E2B_URL="${E2B_API_URL:-}" E2B_SBX_URL="${E2B_SANDBOX_URL:-}" CFG_PATH="$cfg" \
  node --input-type=module -e '
    import fs from "node:fs"
    import YAML from "yaml"
    const p = process.env.CFG_PATH
    const doc = YAML.parse(fs.readFileSync(p, "utf8"))
    doc.agent = doc.agent || {}
    doc.agent.sandbox = { ...(doc.agent.sandbox || {}), mode: "e2b", apiKey: process.env.E2B_KEY, apiUrl: process.env.E2B_URL, sandboxUrl: process.env.E2B_SBX_URL }
    fs.writeFileSync(p, YAML.stringify(doc))
  ' || die "写配置失败（已保留备份）" 2
  ok "已写入 $cfg（agent.sandbox.mode=e2b，原文件已备份为 *.bak.*）"
  warn "插件端生效：保存配置即热加载；若插件未运行，下次启动生效"
}

# =============================================================================
# 卸载
# =============================================================================
uninstall_e2b() {
  step "卸载 E2B 自托管栈"
  [ -n "$E2B_DIR" ] && [ -d "$E2B_DIR" ] || die "未找到 ${E2B_DIR}" 2
  COMPOSE_DIR="$E2B_DIR/embed/compose"
  if [ -d "$COMPOSE_DIR" ]; then
    confirm "将停栈并删除容器/数据卷（clone 目录保留）" || die "已取消" 2
    ( cd "$COMPOSE_DIR" && docker compose --profile test down -v ) || warn "compose down 出错（可能本来就未运行）"
    local teardown="$COMPOSE_DIR/scripts/host-teardown.sh"
    if [ -f "$teardown" ]; then
      confirm "执行官方 host-teardown.sh（还原宿主内核参数/hugepages）" && bash "$teardown" || warn "已跳过宿主还原"
    fi
  fi
  ok "已卸载。插件侧请把 agent.sandbox.mode 改回 off（或删掉 apiKey），否则终端工具会因连不上沙箱而 fail-closed 拒绝执行"
}

# =============================================================================
main() {
  log "${C_DIM}E2B Embed 一键部署（agents-plugin 沙箱执行面）${C_END}"
  if [ "$UNINSTALL" = "1" ]; then uninstall_e2b; exit 0; fi
  preflight
  if [ "$CHECK_ONLY" = "1" ]; then ok "--check 结束：本机满足前置要求，可去掉 --check 执行安装"; exit 0; fi
  install_deps
  install_e2b
  verify_and_export
  step "完成"
  log "下一步："
  log "  1) 插件里确认 agent.sandbox.mode=e2b（上面已给配置片段/可用 --write-config 写入）"
  log "  2) 跑真连接集成测试："
  log "     ${C_DIM}E2B_INTEGRATION=1 node model/sandbox/e2b.integration.test.mjs${C_END}"
  log "  3) 认领 terminal 主人后让 Agent 执行命令：#agents设置主人 → 控制台验证码 → 直接发码"
}

main "$@"

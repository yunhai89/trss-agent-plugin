#!/bin/sh
# lib-ensure-docker.sh
# ----------------------------------------------------------------------------
# 被其它安装脚本 `source`（不要直接执行）：提供 ensure_docker()，无 docker / compose
# 时按发行版自动安装并启动守护进程，装好或已就绪都幂等返回。
#
# 环境变量（都可留空）：
#   DOCKER_AUTO_INSTALL=0   仅检查不安装（缺 docker 时返回 1，由调用方给出手动安装指引）
#   DOCKER_ASSUME_YES=1     无人值守：跳过安装前确认（CI / -y）
#   DOCKER_INSTALL_ARGS=""  追加到包管理器命令的额外参数
#
# 产出：
#   DOCKER_COMPOSE          就绪时导出为 "docker compose" 或 "docker-compose"
# 返回：0 = docker + compose v2 就绪且守护进程在跑；1 = 不可用（已打印原因）
#
# 安全约束（deploy 层）：只用发行版包管理器安装（apt/dnf/yum/apk），**不** curl|sh
# 远程脚本；非交互且未显式 DOCKER_ASSUME_YES 时默认取消，绝不静默改系统。
# ----------------------------------------------------------------------------

# 输出桥接：调用方若定义了 ok/warn 就用它，否则回退到纯文本
_ed_ok()   { command -v ok   >/dev/null 2>&1 && ok   "$@" || printf '  ✓ %s\n' "$@"; }
_ed_warn() { command -v warn >/dev/null 2>&1 && warn "$@" || printf '  ! %s\n' "$@" >&2; }
_ed_info() { command -v log  >/dev/null 2>&1 && log  "$@" || printf '  · %s\n' "$@"; }

_ed_confirm() {
  [ "${DOCKER_ASSUME_YES:-0}" = "1" ] && return 0
  printf '%s [y/N] ' "$1"
  read -r _ed_a || return 1
  case "$_ed_a" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# 探测可用的 compose 命令（v2 插件优先）
_ed_compose_cmd() {
  if docker compose version >/dev/null 2>&1; then printf 'docker compose'; return 0; fi
  if command -v docker-compose >/dev/null 2>&1 && docker-compose version >/dev/null 2>&1; then printf 'docker-compose'; return 0; fi
  return 1
}

# 启动/等待 docker 守护进程（systemd → SysV → OpenRC），最多 15s
_ed_start_daemon() {
  docker info >/dev/null 2>&1 && return 0
  _ed_warn "docker 守护进程未运行，尝试启动…"
  if command -v systemctl >/dev/null 2>&1; then systemctl enable --now docker >/dev/null 2>&1 || true; fi
  if ! docker info >/dev/null 2>&1 && command -v service >/dev/null 2>&1; then service docker start >/dev/null 2>&1 || true; fi
  if ! docker info >/dev/null 2>&1 && command -v rc-service >/dev/null 2>&1; then rc-service docker start >/dev/null 2>&1 || true; fi
  i=0
  while [ "$i" -lt 15 ]; do
    docker info >/dev/null 2>&1 && return 0
    i=$((i + 1)); sleep 1
  done
  docker info >/dev/null 2>&1
}

# 用系统包管理器安装（$@ = 包名列表）
_ed_install_pkgs() {
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y && apt-get install -y "$@"
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y "$@"
  elif command -v yum >/dev/null 2>&1; then
    yum install -y "$@"
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache "$@"
  else
    return 127
  fi
}

ensure_docker() {
  DOCKER_COMPOSE=""

  # 1) docker 已在：补齐 compose（若缺），启动守护进程
  if command -v docker >/dev/null 2>&1; then
    c="$(_ed_compose_cmd || true)"
    if [ -n "$c" ]; then
      DOCKER_COMPOSE="$c"; export DOCKER_COMPOSE
      _ed_start_daemon || { _ed_warn "docker 已装但守护进程起不来：请检查 systemctl status docker / 容器日志"; return 1; }
      _ed_ok "docker 已就绪（$(docker --version 2>/dev/null)，compose：$DOCKER_COMPOSE）"
      return 0
    fi
    _ed_warn "已装 docker 但缺少 compose v2，尝试补齐…"
  else
    _ed_info "未检测到 docker。"
  fi

  # 2) 允许关闭自动安装（缺 docker 时给出手动指引）
  if [ "${DOCKER_AUTO_INSTALL:-1}" = "0" ]; then
    _ed_warn "DOCKER_AUTO_INSTALL=0：不自动安装。请手动安装 docker + compose v2 后重跑（https://docs.docker.com/engine/install/）。"
    return 1
  fi

  # 3) 按发行版选包名
  if command -v apt-get >/dev/null 2>&1; then
    _ed_pkgs="docker.io docker-compose-v2"
    _ed_fallback="docker.io docker-compose"
  elif command -v dnf >/dev/null 2>&1; then
    _ed_pkgs="docker docker-compose-plugin"
    _ed_fallback="docker docker-compose"
  elif command -v yum >/dev/null 2>&1; then
    _ed_pkgs="docker docker-compose-plugin"
    _ed_fallback="docker docker-compose"
  elif command -v apk >/dev/null 2>&1; then
    _ed_pkgs="docker docker-cli-compose"
    _ed_fallback="docker docker-compose"
  else
    _ed_warn "无受支持的包管理器（apt/dnf/yum/apk）：请手动安装 docker + compose v2。参考 https://docs.docker.com/engine/install/"
    return 1
  fi
  if [ -n "${DOCKER_INSTALL_ARGS:-}" ]; then _ed_pkgs="$_ed_pkgs $DOCKER_INSTALL_ARGS"; fi

  _ed_confirm "将安装 Docker 及 compose（$_ed_pkgs）；会改动系统包与 /etc，并可能重启 docker 服务。继续？" \
    || { _ed_warn "已取消安装 Docker（可设 DOCKER_ASSUME_YES=1 无人值守安装）。"; return 1; }

  _ed_info "安装中：$_ed_pkgs …"
  # shellcheck disable=SC2086
  if ! _ed_install_pkgs $_ed_pkgs; then
    _ed_warn "首选包名安装失败，尝试回退包名：$_ed_fallback …"
    # shellcheck disable=SC2086
    _ed_install_pkgs $_ed_fallback || true
  fi

  command -v docker >/dev/null 2>&1 || { _ed_warn "安装后仍未找到 docker 命令。请手动安装后重跑。"; return 1; }
  _ed_start_daemon || { _ed_warn "docker 安装成功但守护进程未就绪。排查：systemctl status docker"; return 1; }

  DOCKER_COMPOSE="$(_ed_compose_cmd || true)"
  if [ -z "$DOCKER_COMPOSE" ]; then
    _ed_warn "docker 已装但 compose v2 不可用（docker compose version 失败）。请安装 docker-compose-plugin / docker-compose-v2 后重跑。"
    return 1
  fi
  export DOCKER_COMPOSE
  _ed_ok "Docker 安装完成（$(docker --version 2>/dev/null)，compose：$DOCKER_COMPOSE）"
  return 0
}

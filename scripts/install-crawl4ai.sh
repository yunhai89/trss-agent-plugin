#!/bin/sh
# install-crawl4ai.sh
# ----------------------------------------------------------------------------
# 安装 crawl4ai 抓取运行时（独立 venv + Playwright Chromium），供
# model/crawl/crawl4ai.js 以子进程方式调用（网页内容获取默认引擎，未装自动降级 fetch）。
#
# 做什么：
#   [1/6] 检查 python3（>=3.10）
#   [2/6] 创建独立 venv（默认 <插件>/.crawl4ai-venv；CRAWL4AI_VENV 覆盖——容器场景可挂卷）
#   [3/6] venv pip 安装 crawl4ai（支持 PIP_INDEX_URL / PIP_EXTRA_ARGS 镜像与加速）
#   [4/6] crawl4ai-setup 安装 Playwright Chromium（PLAYWRIGHT_DOWNLOAD_HOST 可走镜像）
#   [5/6] 验证 import + 版本
#   [6/6] 真实抓取冒烟（example.com；SKIP_VERIFY=1 跳过——离线环境）
#
# 用法：
#   sh plugins/agents-plugin/scripts/install-crawl4ai.sh
# 常用覆盖：
#   PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple sh scripts/install-crawl4ai.sh
#   PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright sh scripts/install-crawl4ai.sh
#   CRAWL4AI_VENV=/data/crawl4ai-venv sh scripts/install-crawl4ai.sh   # 容器重建不丢
# ----------------------------------------------------------------------------

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="$(dirname "$SCRIPT_DIR")"
VENV_DIR="${CRAWL4AI_VENV:-$PLUGIN_ROOT/.crawl4ai-venv}"

echo "[1/6] 检查 python3"
PY="$(command -v python3 || true)"
if [ -z "$PY" ]; then
  echo "错误：未找到 python3（crawl4ai 需要 Python >= 3.10）。请先安装：apt install python3 python3-venv python3-pip" >&2
  exit 1
fi
PYVER="$("$PY" -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
echo "    python3 = $PY ($PYVER)"
"$PY" -c 'import sys; sys.exit(0 if (sys.version_info[0], sys.version_info[1]) >= (3, 10) else 1)' || {
  echo "错误：Python $PYVER < 3.10，crawl4ai 需要 >= 3.10" >&2
  exit 1
}

echo "[2/6] 创建 venv：$VENV_DIR"
"$PY" -m venv "$VENV_DIR" 2>/dev/null || {
  echo "错误：venv 创建失败（缺 python3-venv？Debian/Ubuntu：apt install python3-venv）" >&2
  exit 1
}
VENV_PY="$VENV_DIR/bin/python3"
"$VENV_PY" -m pip install --upgrade pip >/dev/null 2>&1 || echo "    （pip 升级跳过，继续）"

echo "[3/6] 安装 crawl4ai（可用 PIP_INDEX_URL 走镜像）"
if [ -n "$PIP_INDEX_URL" ]; then echo "    使用镜像：$PIP_INDEX_URL"; fi
"$VENV_PY" -m pip install --upgrade crawl4ai ${PIP_EXTRA_ARGS:-}

echo "[4/6] crawl4ai-setup（安装 Playwright Chromium；可用 PLAYWRIGHT_DOWNLOAD_HOST 走镜像）"
# 前置：浏览器已可用（全局缓存 ~/.cache/ms-playwright 已有匹配版本）则直接跳过下载——
# 重装/升级场景下 playwright 可能因安装标记缺失重下 184MB 且默认源易停滞
smoke_url_test() {
  echo '{"url":"https://example.com","timeout_s":30,"max_chars":500}' \
    | "$VENV_PY" "$PLUGIN_ROOT/python/crawl4ai_fetch.py" >/dev/null 2>&1
}
if smoke_url_test; then
  echo "    Chromium 已可用（全局缓存命中），跳过下载"
else
  # Chromium ~184MB 走 cdn.playwright.dev，国内/受限网络常停滞——失败自动用 npmmirror 镜像重试一次
  install_browser() {
    if "$VENV_PY" -m crawl4ai.setup >/dev/null 2>&1; then return 0; fi
    if command -v "$VENV_DIR/bin/crawl4ai-setup" >/dev/null 2>&1 && "$VENV_DIR/bin/crawl4ai-setup"; then return 0; fi
    "$VENV_PY" -m playwright install chromium
  }
  if ! install_browser; then
    echo "    默认源失败，改用 npmmirror 镜像重试 Chromium 下载…"
    PLAYWRIGHT_DOWNLOAD_HOST="${PLAYWRIGHT_DOWNLOAD_HOST:-https://cdn.npmmirror.com/binaries/playwright}" \
      "$VENV_PY" -m playwright install chromium || {
      echo "错误：Chromium 安装失败。手动重试：PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright $VENV_PY -m playwright install chromium" >&2
      exit 1
    }
  fi
fi

echo "[5/6] 验证 import + 版本"
C4AI_VER="$("$VENV_PY" -c 'import crawl4ai; print(crawl4ai.__version__)')"
echo "    crawl4ai $C4AI_VER @ $VENV_DIR"

echo "[6/6] 真实抓取冒烟（SKIP_VERIFY=1 可跳过）"
if [ "${SKIP_VERIFY:-0}" = "1" ]; then
  echo "    已跳过（SKIP_VERIFY=1）"
else
  SMOKE_URL="${SMOKE_URL:-https://example.com}"
  if "$VENV_PY" "$PLUGIN_ROOT/python/crawl4ai_fetch.py" <<EOF
{"url": "$SMOKE_URL", "timeout_s": 45, "max_chars": 2000}
EOF
  then
    echo "    冒烟通过"
  else
    echo "    冒烟失败（exit=$?）——crawl4ai 已装但抓取异常；运行时将自动降级 fetch。可重跑本脚本排查。" >&2
    exit 1
  fi
fi

echo "完成。web_crawl / 知识库 URL 入库将默认走 crawl4ai（真浏览器渲染），失败自动降级 fetch。"
echo "如需强制纯 HTTP：config.yaml → agent.kb.crawl.engine: fetch"

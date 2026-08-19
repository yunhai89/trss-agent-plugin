#!/bin/sh
# install-kroki.sh
# ----------------------------------------------------------------------------
# 部署自托管 Kroki 渲染容器（diagram_render 示意图工具的默认渲染引擎）。
#
# 做什么：
#   [1/5] 检查 docker / docker compose
#   [2/5] 拉取镜像（三级加速策略，见下）
#   [3/5] docker compose up（docs/deploy/kroki-compose.yaml：127.0.0.1:8000 + SECURE 模式 + 资源限额）
#   [4/5] 健康轮询（/health，最长 60s）
#   [5/5] 输出插件配置提示（endpoint / imageTag）
#
# 国内拉取加速策略（依次尝试，任一成功即止）：
#   a. 直拉 yuzutech/kroki@sha256:…（daemon 已配 registry-mirror 时走 mirror，最稳）
#   b. 国内代理前缀逐个试：docker.1ms.run / docker.m.daocloud.io / dockerproxy.net / hub.rat.dev
#      （拉到后 retag 为本地名 agents-kroki-local，并写 docs/deploy/.env 供 compose 引用；
#        latest 漂移风险会做 digest 比对警告——生产建议固定 digest）
#   c. 全部失败 → 报错退出（可手动 docker pull 后重跑）
#
# 用法：
#   sh plugins/agents-plugin/scripts/install-kroki.sh
# 常用覆盖：
#   KROKI_IMAGE=yuzutech/kroki@sha256:…  sh scripts/install-kroki.sh    # 指定镜像（默认为 compose 锚定 digest）
#   KROKI_PULL_PROXIES="a.example/ b.example/" sh scripts/install-kroki.sh  # 自定义代理前缀（空格分隔）
#   KROKI_HEALTH_TIMEOUT=120 sh scripts/install-kroki.sh               # 健康等待上限（秒）
# ----------------------------------------------------------------------------
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="$(dirname "$SCRIPT_DIR")"
COMPOSE_FILE="$PLUGIN_ROOT/docs/deploy/kroki-compose.yaml"
ENV_FILE="$PLUGIN_ROOT/docs/deploy/.env"
LOCAL_TAG="agents-kroki-local:current"
# 默认锚定 digest（与 compose 文件一致；升级流程见 compose 内注释）
DEFAULT_IMAGE="yuzutech/kroki@sha256:6980bfb218b48b74ea14b888d9c7e8c032d1cb6325f3292277abdf62483abd9d"
EXPECT_DIGEST="sha256:6980bfb218b48b74ea14b888d9c7e8c032d1cb6325f3292277abdf62483abd9d"
HEALTH_TIMEOUT="${KROKI_HEALTH_TIMEOUT:-60}"

echo "[1/5] 检查 docker"
command -v docker > /dev/null || { echo "错误：未找到 docker。先安装 Docker（国内服务器可用阿里云/清华源 apt 仓库）。" >&2; exit 1; }
if docker compose version > /dev/null 2>&1; then COMPOSE="docker compose"
elif command -v docker-compose > /dev/null 2>&1; then COMPOSE="docker-compose"
else echo "错误：未找到 docker compose 插件/独立二进制。" >&2; exit 1; fi
echo "    docker + compose 就绪（$COMPOSE）"

echo "[2/5] 拉取 Kroki 镜像（国内加速三级策略）"
TARGET_IMAGE="${KROKI_IMAGE:-$DEFAULT_IMAGE}"
if docker pull "$TARGET_IMAGE" 2> /tmp/kroki-pull.err; then
  echo "    直拉成功（daemon registry-mirror 生效或网络可达）: $TARGET_IMAGE"
  # 清掉历史加速路径写的 .env，让 compose 回落 digest 默认（避免本地 tag 过期）
  [ -f "$ENV_FILE" ] && rm -f "$ENV_FILE" && echo "    已清理过期的 $ENV_FILE"
else
  echo "    直拉失败（$(head -c 120 /tmp/kroki-pull.err)），尝试国内代理前缀…"
  PULLED=""
  for prefix in ${KROKI_PULL_PROXIES:-"docker.1ms.run/ docker.m.daocloud.io/ dockerproxy.net/ hub.rat.dev/"}; do
    REF="${prefix}yuzutech/kroki:latest"
    echo "    · 试 $REF"
    if docker pull "$REF" 2> /dev/null; then PULLED="$REF"; break; fi
  done
  [ -n "$PULLED" ] || { echo "错误：所有拉取方式均失败。可手动 docker pull 后设 KROKI_IMAGE=<本地名> 重跑。" >&2; exit 1; }
  # digest 比对警告：代理拉的是 latest，漂移风险提示（不阻塞）
  GOT="$(docker inspect --format '{{index .RepoDigests 0}}' "$PULLED" 2> /dev/null | sed 's/.*@//')"
  [ "$GOT" = "$EXPECT_DIGEST" ] || echo "    ⚠️ 代理拉取的 latest digest（${GOT:-未知}）与锚定值不一致，存在版本漂移风险；生产建议改用 digest 直拉"
  docker tag "$PULLED" "$LOCAL_TAG"
  printf 'KROKI_IMAGE=%s\n' "$LOCAL_TAG" > "$ENV_FILE"
  TARGET_IMAGE="$LOCAL_TAG"
  echo "    已 retag 为本地镜像并写入 $ENV_FILE（compose 将引用它）"
fi

echo "[3/5] 启动容器（$COMPOSE -f docs/deploy/kroki-compose.yaml up -d）"
if [ -f "$ENV_FILE" ] && grep -q '^KROKI_IMAGE=' "$ENV_FILE"; then
  (cd "$PLUGIN_ROOT/docs/deploy" && $COMPOSE up -d)
else
  $COMPOSE -f "$COMPOSE_FILE" up -d
fi

echo "[4/5] 健康轮询（最长 ${HEALTH_TIMEOUT}s）"
i=0
while [ "$i" -lt "$HEALTH_TIMEOUT" ]; do
  if curl -sf -o /dev/null --max-time 3 http://127.0.0.1:8000/health 2> /dev/null; then
    echo "    healthy（${i}s）"; break
  fi
  i=$((i + 3)); sleep 3
done
if ! curl -sf -o /dev/null --max-time 3 http://127.0.0.1:8000/health 2> /dev/null; then
  echo "错误：容器未在 ${HEALTH_TIMEOUT}s 内通过健康检查。排查：docker logs agents-kroki" >&2
  exit 1
fi
VER="$(curl -sf --max-time 5 http://127.0.0.1:8000/health 2> /dev/null | sed 's/.*"kroki":{"number":"\([^"]*\)".*/\1/')"
D2="$(curl -sf --max-time 5 http://127.0.0.1:8000/health 2> /dev/null | sed 's/.*"d2":"\([^"]*\)".*/\1/')"
echo "    Kroki ${VER:-未知} / D2 ${D2:-未知}"

echo "[5/5] 完成。插件配置（config.yaml 或 Web 配置中心「示意图生成」）："
echo "    agent.diagram.kroki.endpoint: http://127.0.0.1:8000"
echo "    agent.diagram.kroki.imageTag: ${EXPECT_DIGEST}（进缓存 key；升级镜像后必须更新使旧缓存失效）"
echo "    验证（真实容器集成测试）：KROKI_INTEGRATION=1 node model/diagram/kroki.integration.test.mjs"

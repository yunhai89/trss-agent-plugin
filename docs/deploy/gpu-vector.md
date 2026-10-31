# GPU 向量检索部署（cuVS / cuvs-node）

> 本文是主 README 的拆分文档。返回 [README](../README.md)。

知识库默认使用 Flat/HNSW。本文只针对 **NVIDIA GPU + Linux x86_64** 的 cuVS 加速部署。GPU 方案不会自动启用，必须由用户显式授权。

## 1. 适用条件

| 项目 | 要求 |
| --- | --- |
| 操作系统 | Linux x86_64（`cuvs-node` 只发布 linux-x64 预编译包） |
| GPU | NVIDIA，驱动支持 CUDA 12.x（`nvidia-smi` 可正常输出） |
| Node.js | >= 20（本机实测 24.22.1） |
| 磁盘 | 约 3 GB 可用空间（下载包约 1.8 GB，解压后约 2.6 GB） |
| 内存 | 建议 >= 4 GB 空闲 |
| glibc | 建议 GLIBCXX >= 3.4.31（Ubuntu 22.04+ 通常满足） |

先确认 GPU 空闲，避免抢占用户已有任务：

```bash
nvidia-smi
nvidia-smi --query-gpu=name,memory.total,memory.used,driver_version --format=csv,noheader
nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader
```

## 2. 安装 cuvs-node

`cuvs-node` **不是默认依赖**，只有 GPU 用户需要手动安装。安装脚本会从 GitHub Release 下载约 1.8 GB 预编译 CUDA 运行时。

```bash
cd plugins/agents-plugin
pnpm add cuvs-node
```

如果 pnpm/npm 提示 install script 被忽略：

```bash
pnpm approve-builds          # pnpm
# 或 npm 11+
npm install-scripts approve cuvs-node
pnpm rebuild cuvs-node
```

### 下载慢/失败

安装脚本的下载地址是：

```text
https://github.com/638Labs/cuvs-node/releases/download/v0.0.5/prebuilds-linux-x64.tar.gz
```

国内网络可手动用镜像下载后解压到包的 `prebuilds/linux-x64/`（目录中必须有 `libcuvs_c.so`）：

```bash
# 示例：使用 gh-proxy.org 加速（本机实测约 3.8 MB/s，1.8 GB 约 8 分钟）
curl -L -o /tmp/prebuilds-linux-x64.tar.gz \
  "https://gh-proxy.org/https://github.com/638Labs/cuvs-node/releases/download/v0.0.5/prebuilds-linux-x64.tar.gz"

mkdir -p node_modules/cuvs-node/prebuilds/linux-x64
tar -xzf /tmp/prebuilds-linux-x64.tar.gz -C node_modules/cuvs-node/prebuilds/linux-x64
```

也可以先 `pnpm add --ignore-scripts cuvs-node`，再按上面解压。

### 冒烟测试

```bash
node -e "const { Resources } = require('cuvs-node'); const r = new Resources(); r.dispose(); console.log('cuvs ok')"
```

输出 `cuvs ok` 才说明 CUDA 运行时和 GPU 绑定正常。

## 3. 配置

```yaml
agent:
  kb:
    vectorBackend: cuvs
    vectorGpuConsent: true   # 必须显式授权；auto 永远不会启用 GPU
    cuvs:
      algorithm: brute_force # 默认：GPU 精确检索，质量优先
      rerank: 4
```

两种 GPU 算法：

| algorithm | 特点 | 适用 |
| --- | --- | --- |
| `brute_force` | GPU 精确检索，结果与 Flat 一致；10k×128 本机约 0.2ms/次 | 默认，插件规模优先质量 |
| `cagra` | GPU 图索引，建库更快；`cuvs-node` 单次 `k` 上限 64，候选再用 Flat 精确重排 | 数据量更大、可接受少量召回损失 |

修改后需要重启进程（代码/依赖变更）或 `#agent重载`（仅配置变更）。确认状态：

```text
#向量库状态
```

应显示 `后端：cuvs`、GPU 型号、`cuVS：algorithm=...`，且没有降级原因。

## 4. 真机验证（必须做）

### 4.1 一键性能/质量自检

```bash
node scripts/vector-benchmark.mjs --n=10000 --dim=128 --queries=50 --topk=5 --cuvs
# 测 CAGRA：
node scripts/vector-benchmark.mjs --n=10000 --dim=128 --queries=50 --topk=5 --cuvs --cuvs-algorithm=cagra
```

会输出 Flat / HNSW / cuVS 的建库、查询延迟，以及相对 Flat 精确结果的 topK 重合率。

### 4.2 GPU 真机回归测试

```bash
node model/agent/vector-gpu.test.mjs
```

覆盖：cuVS BruteForce 与 Flat 结果一致、持久化、增删改、CAGRA 建库/查询、KnowledgeStore 入库/检索/重建。没有 GPU 或未装 `cuvs-node` 时会明确 `SKIP_FILE`，不会误报通过。

### 4.3 本机实测基线

测试环境：RTX 2080 8GB、驱动 580.178.04（CUDA 13.0）、Ubuntu + glibc 2.39、Node 24.22.1、cuvs-node 0.0.6。

| 方案 | 10k×128 建库+落盘 | 平均查询 | 相对 Flat top5 重合率 |
| --- | --- | --- | --- |
| Flat（精确） | 52ms | 5.76ms | 100% |
| HNSW（CPU） | 3.39s | 0.78ms | 96.4% |
| cuVS BruteForce（GPU） | 366ms | 0.21ms | 100% |
| cuVS CAGRA（GPU） | 733ms | 0.65ms | 89.6% |

> 合成随机向量的 CAGRA 召回是偏保守的下界；真实 embedding 通常更聚类。需要严格质量时用 `brute_force`。

`vector-gpu.test.mjs` 本机结果：13 通过，0 失败。

## 5. 安全与回滚

- `auto` 只会在 HNSW/Flat 之间选择，**绝不会自动启用 GPU**。
- 只有 `vectorBackend: cuvs` **且** `vectorGpuConsent: true` 才会初始化 GPU。
- 安装/启用前先看 `nvidia-smi`，确认显存和 GPU 进程空闲。
- cuVS 初始化失败/模块缺失/未授权时自动回退 HNSW 或 Flat，不阻断知识库。
- 回滚：

```yaml
agent:
  kb:
    vectorBackend: auto
    vectorGpuConsent: false
```

重启后生效；可删除 `data/vectors/kb/cuvs.bin` / `cuvs.json` 释放磁盘。

## 6. 常见问题

| 现象 | 处理 |
| --- | --- |
| `cuvs-node 不可用` / `Cannot find module` | 未安装或不在插件 `node_modules`；执行 `pnpm add cuvs-node` |
| `Could not locate the bindings file` | install script 被忽略；`pnpm rebuild cuvs-node` 或手动解压 prebuilds |
| 下载 1.8GB 很慢 | 用上面的 `gh-proxy.org` 手动下载；确认镜像返回的是 tarball 而不是 HTML |
| `cuvsCagraSearch failed` | CAGRA 单次 `k` 上限 64；把 `algorithm` 设为 `brute_force` 或降低 topK |
| 显存不足/OOM | 关闭其它 GPU 任务；减少知识库规模；改用 HNSW/Flat |
| 驱动不兼容 | 升级 NVIDIA 驱动到支持 CUDA 12.x 的版本；`nvidia-smi` 必须正常 |
| `#向量库状态` 显示 hnsw/flat 且有降级原因 | 按原因修复；常见为未授权、未安装、GPU 不可用 |

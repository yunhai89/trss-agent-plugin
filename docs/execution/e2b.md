# 终端执行与 E2B 沙箱

> 本文是主 README 的拆分文档。返回 [README](../../README.md)。

## 💻 终端执行（E2B 沙箱 + 全员可用）

> **⚠️ 高危**：见上方「安全与信任边界」。`terminal` 默认不注册，需 `agent.sandbox.mode: e2b` + `apiKey` **单独开启**；开启即视为你知晓风险并自担后果。

`terminal` 工具让 Agent 在 **E2B 微虚机**里执行 shell 命令。宿主上**没有任何模型可驱动的 shell 执行面**（旧主机执行路径已删除），拿不到沙箱就拒绝执行。

**同类执行面（2025-10 起）**：内置工具里凡涉及 shell/子进程的，显式选择 `mode: e2b` 后一律改在**会话沙箱内**执行，宿主不再起这些子进程（唯一例外是 `web_crawl` 的 crawl4ai，它是本机引擎，见下表末行）：

| 工具 | 宿主档（mode=off） | 沙箱档（mode=e2b） |
| --- | --- | --- |
| `terminal` | 不注册 | 会话沙箱内执行任意命令 |
| `calculate` | 宿主 `python3`（受限解释器） | 沙箱内 `python3`（代码上传为文件，不拼命令行） |
| `web_download` | 宿主 `yt-dlp` | 沙箱内 `yt-dlp`，产物流式拉回宿主再发送 |
| `transcribe_media` | 宿主 `ffmpeg` 提取音频 | 沙箱内 `ffmpeg` 提取，mp3 拉回宿主再调 STT API（Key 不进沙箱） |
| `file_to_pdf` | 宿主 `soffice` | 沙箱内 `soffice`，PDF 拉回；沙箱缺 soffice 时回退纯 JS 渲染（无 shell） |
| `web_crawl` | 宿主 python crawl4ai（**默认恒走这里**：本地引擎，与 sandbox.mode 无关，同 diagram 的本机 Kroki） | 仅当 `agent.kb.crawl.execution: sandbox` 时在沙箱内 crawl4ai（脚本+请求文件上传，模板需预装 crawl4ai）；沙箱缺 crawl4ai → 降级纯 HTTP fetch |
| `install_skill` | 宿主 `skillhub`（固定 argv） | 沙箱内 `skillhub`，只回传 `.md` 产物，校验后进宿主 skills/ |

**转档/读取类工具的宿主路径白名单（v1.26.30 起）**：`file_to_pdf`（发 PDF 进群）、`read_pdf`、`read_excel`、`transcribe_media` 只允许读插件 `data/temp` 内的文件——这些工具是 `category: 'query'`（任意群成员免审批），此前接受任意宿主路径，等于任何成员都能把 `config/config.yaml`、`.env`、`data/logs/*.log` 原样转成 PDF 发进群（不可撤回）。需要处理宿主其它位置的文件时，先复制到 `data/temp`。

**`web_download` 的地址门禁（v1.26.23 起）**：与 `web_crawl` 同一套 `checkTargetAllowed`——默认拒绝本机/内网/云元数据地址（`127.0.0.1`、`169.254.169.254`、`::1`、`10/172.16/192.168` 段，含混淆写法与域名解析结果），命中直接结构化失败并附提示。确需下载本地媒体服务器（NAS 等）时设 `agent.download.allowPrivateHosts: true`。原因是 yt-dlp 以**宿主身份**按通用 URL 抓取，内网响应体还会被回发到群里，也可被抓取内容里的提示注入诱导。

> 沙箱不可用（E2B 连不上/初始化失败）时这些工具一律 **fail-closed** 结构化失败，**绝不回落宿主执行**；沙箱模板缺依赖（`python3`/`yt-dlp`/`ffmpeg`/`soffice`/`crawl4ai`/`skillhub`）会返回可读提示，请把它们装进 `agent.sandbox.template` 指向的模板。命令同样计入 `maxCommandsPerSession`（与 terminal 共用会话预算），输入/产物的文件传输走流式（大文件不整块进内存）。
>
> `web_crawl` 例外说明：crawl4ai 是**本机引擎**（宿主 venv，`scripts/install-crawl4ai.sh` 装的就是它；与 diagram 的本机 Kroki 同类），默认**不随** `sandbox.mode` 进沙箱——否则沙箱模板没预装 crawl4ai 时整条抓取链路会恒降级 fetch，反倒丢掉宿主已装好的浏览器。想让网页渲染在沙箱内发生时，显式配 `agent.kb.crawl.execution: sandbox`（需 `mode: e2b` + 模板预装 crawl4ai；该档沙箱未就绪时降级纯 HTTP fetch，不改跑宿主 crawl4ai）。

**接入准备**（二选一，详见仓库内 `e2b-infra-nodejs-安全shell接入开发文档.md`）：
- **E2B 云**：只填 `sandbox.apiKey`（注意：命令与文件会送往第三方）。
- **自托管 Embed**：**仅限有 KVM 的机器**（自家物理机 / 裸金属实例）。腾讯云轻量服务器、普通 CVM/ECS 虚拟机、容器都不行，请用上面的云托管。详见下方「自托管安装」。

> 说明：插件依赖的 `e2b` npm 包只是 **SDK（客户端）**，不含任何沙箱服务端。沙箱由 `e2b-dev/runtime`（Firecracker 基础设施）提供，云托管由 E2B 运营，自托管需自己部署。

### 🏗️ 自托管安装（E2B Embed）

**硬前提（不满足就不要尝试，装了也跑不起来）**：

| 项 | 要求 | 为什么 |
| --- | --- | --- |
| KVM | `/dev/kvm` 存在且可读写 | 每个沙箱是一台 Firecracker microVM，没有硬件虚拟化就无从创建 |
| CPU 虚拟化 | `/proc/cpuinfo` 含 `vmx`（Intel）或 `svm`（AMD） | 没暴露虚拟化扩展的客机＝嵌套虚拟化未开启，**客机内部无法自行开启** |
| 内存 | 宿主可用内存 ≥ 20 GiB（`PF_MIN_FREE_GIB`） | embed 会为沙箱预留大块内存 |
| 磁盘 | 空闲 ≥ 30 GiB | 7 个镜像 + Firecracker + 内核 + 模板 |
| 系统 | Linux x86-64/arm64，4 KiB 页内核，glibc ≥ 2.34，可写 `/etc` | 官方以 Ubuntu/Debian 验证；不支持 macOS/Windows 宿主与 Container-Optimized OS |

> ## ⚠️ 重要：自托管**必须有 KVM**，普通云服务器做不到
>
> E2B 的每个沙箱是一台 **Firecracker microVM**，靠 CPU 硬件虚拟化（Intel VT-x / AMD-V）隔离。
> 因此自托管要求机器上真的有 `/dev/kvm`——**普通云服务器（虚拟机）一律没有**：
>
> | 机器类型 | 能自托管吗 | 原因 |
> | --- | --- | --- |
> | 自家物理机 / 裸金属服务器 | ✅ 可以（需 BIOS 开 VT-x/AMD-V） | 真机有硬件虚拟化 |
> | **腾讯云轻量应用服务器** | ❌ **不行** | 本身是虚拟机，不提供嵌套虚拟化，无 `/dev/kvm` |
> | 腾讯云 CVM 标准型 / 阿里云 ECS 共享型·通用型（常见规格） | ❌ 基本不行 | 同上，默认不开嵌套虚拟化（个别规格需工单开通且仍受限） |
> | 裸金属实例 / 专属宿主机（腾讯云黑石、阿里云神龙裸金属等） | ✅ 可以 | 直通硬件虚拟化 |
> | 明确标注「支持嵌套虚拟化」的实例 | ✅ 可以（需单独开通） | 如 GCE `--enable-nested-virtualization` |
> | 各种容器 / Docker 内 / WSL2 | ❌ 不行 | 没有独立的 KVM 设备 |
>
> **结论：如果你用的是腾讯云轻量服务器（以及绝大多数普通云主机、容器），自托管这条路走不通——请直接用 E2B 云托管**（只填 `agent.sandbox.apiKey`，命令与文件会送往 E2B 云，请自行评估数据敏感度）。
>
> 想在云上自托管，只能换到**裸金属 / 专属宿主机**这类有硬件虚拟化的实例。
>
> 不确定？在目标机器上跑体检（不改系统）：`scripts/install-e2b-selfhost.sh --check`。
> 典型失败输出：`/dev/kvm 不存在` + `CPU 未向本机暴露虚拟化扩展`。
>
> 另注：除 KVM 外还需 **可用内存 ≥ 20 GiB / 空闲磁盘 ≥ 30 GiB**——轻量服务器这类小规格即使有 KVM 也不够。

**一键部署脚本**（推荐，内置上述前提检查，不满足会直接拒绝而不是"装一半"）：

```bash
# ① 只做前提检查（可先在候选机器上跑，不改系统）
scripts/install-e2b-selfhost.sh --check

# ② 安装（交互式；-y 无人值守；--write-config 装完直接写进插件配置）
scripts/install-e2b-selfhost.sh -y --write-config

# ③ 卸载（停栈 + 官方 host-teardown 还原宿主参数）
scripts/install-e2b-selfhost.sh --uninstall
```

脚本会：检查前提 → apt 装 docker/compose v2/依赖 → 克隆 `e2b-dev/runtime` 到 `/opt/e2b-runtime` → 执行官方 `host-setup.sh`（hugepages/nbd/sysctl）→ `docker compose up -d --wait` → 跑官方 smoke 自检 → 用控制面 curl 实证创建沙箱 → 导出 `sdk.env` 三要素并给出配置片段（`--write-config` 会备份后直接改写 `config/config.yaml`）。

可调环境变量：`E2B_REF`（锁定 runtime 版本，生产建议锁 CalVer tag）、`E2B_DIR`、`PF_MIN_FREE_GIB`、`MIN_DISK_GIB`、`SKIP_SMOKE`。

**手工步骤**（想自己掌控每一环节时）：

```bash
sudo apt-get install -y git make docker.io docker-compose-v2 qemu-kvm
git clone https://github.com/e2b-dev/runtime.git && cd runtime/embed/compose
bash scripts/host-setup.sh            # hugepages / nbd / sysctl
docker compose up -d --wait
docker compose --profile test run --rm smoke   # 冒烟：栈内跑官方 JS SDK + 端口连通性
eval "$(docker compose exec ready cat /run/e2b/sdk.env)"   # E2B_API_URL / E2B_SANDBOX_URL / E2B_API_KEY
```

把三要素填进 `agent.sandbox.apiUrl / sandboxUrl / apiKey`：

```yaml
agent:
  sandbox:
    mode: e2b
    apiKey: "<sdk.env 里的 E2B_API_KEY>"
    apiUrl: "http://<host>:3000"        # 控制面
    sandboxUrl: "http://<host>:3002"    # 数据面（无通配 DNS 时**必须填**，SDK 会自动附路由头）
    template: base
```

**排障**：

| 症状 | 定位 |
| --- | --- |
| `--check` 报无 `/dev/kvm` | 见上表：换支持 KVM 的机器/实例规格，或改用云托管 |
| 控制面 401 / `Unauthorized` | `apiKey` 取错，重读 `/run/e2b/sdk.env` |
| `fetch failed` 或连 `:3002` 失败 | `sandboxUrl` 未填或 client-proxy 未起：`docker compose ps` 看服务 |
| `TemplateError: You need to update the template` | 模板的 envd 版本过旧，栈内重跑 base 模板构建脚本 |
| 沙箱跑到一半消失 | TTL 到期；长任务用续期（插件侧 `sandboxTtlMs` + 半衰续期已内置） |
| smoke 失败 | `docker compose logs` 逐个服务看；常见是内存/磁盘不足或内核参数未生效 |

部署完成后验证插件侧链路：

```bash
E2B_INTEGRATION=1 node model/sandbox/e2b.integration.test.mjs
# 自托管会从插件配置读 apiUrl/sandboxUrl；环境变量优先，便于临时指向别处
```


**访问控制**：
- **全员可用（无身份门槛）**：不再有「terminal 主人」验证码认领。安全边界完全由 E2B microVM 承担：每个会话（群/用户/对话）独占一个沙箱，文件与进程互不可见。
- **无审批、无命令黑名单**：破坏性命令被限制在会话沙箱内（独立 VM/独立 FS/独立网络命名空间），不再靠字符串规则。
- **成本闸**：`maxCommandsPerSession`（单会话命令数上限）、`maxTimeout`（单命令超时）、`maxSandboxes`（全局并发）+ 闲置回收，防任何用户（含被注入诱导的会话）把配额/账单打爆。

**关键配置（`agent.sandbox`）**：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `mode` | `off` | `off`=terminal 不注册（toolEvo 走本地 fork 档）\| `e2b`=沙箱执行 |
| `apiKey` | 空 | E2B 云或自托管团队 key（★敏感，已接入回复脱敏） |
| `apiUrl` / `domain` / `sandboxUrl` | 空 | 自托管控制面 / 沙箱域名 / 数据面（client-proxy）地址；云托管留空 |
| `template` | `base` | 沙箱模板（CPU/内存/预装依赖由模板承载） |
| `verifyTemplate` | 空 | toolEvo 行为验证专用模板（留空=复用 `template`） |
| `maxTimeout` | `600` | 单命令超时上限（秒） |
| `defaultCwd` | `/home/user` | 沙箱内默认工作目录（宿主路径在沙箱内无意义） |
| `idleMs` / `sandboxTtlMs` | `300000` / `600000` | 闲置回收阈值 / 沙箱 TTL（毫秒，命中时自动续期） |
| `maxSandboxes` / `concurrencyWaitMs` | `4` / `15000` | 全局并发上限 / 等名额超时（超时按配额失败） |
| `maxCommandsPerSession` | `50` | 单会话命令数上限（0=不限） |
| `requestTimeoutMs` / `retries` | `60000` / `1` | E2B SDK 单请求超时（毫秒）/ 重试次数（云默认 3，这里默认降为 1 控延迟） |
| `allowPublicTraffic` | `false` | 沙箱公开 URL 也要求 token（默认收紧） |
| `network.allowInternet` | `true` | 总出口开关：`true`=放通全部出口（E2B 原生默认）；`false`=完全断网（配了 `allowOut` 白名单时白名单仍放行） |
| `network.allowOut` / `denyOut` | 空 / 空 | `allowOut` 白名单（可选收紧）：配了只放行白名单、其余全拒；`denyOut` 在放通基础上额外封禁网段（如防云元数据 `169.254.169.254/32`）。**别写 `0.0.0.0/0`**：它是「拒绝一切（含 DNS）」，旧版本默认值会在启动时被自动清理 |
| `audit` | `true` | 每条命令写审计日志（会话键/退出码/命令前 200 字符，不含密钥） |

> 上述字段（含网络白名单/审计/`verifyTemplate`）都可在 Web 配置中心与锅巴「E2B 沙箱」分组里编辑，无需手改 yaml。

> 沙箱会话按「群 + 用户 + 会话」绑定：同一会话内文件与进程状态连续（可先装依赖再跑脚本）。群共享模式（`isolation: false`）下同群共用一个沙箱。
>
> **出口排查**：启动日志会打印一行「`[sandbox] 出口网络：…`」（实际下发的 `network` 与放通范围），创建沙箱时也带该摘要；主人可用 **`#沙箱诊断`** 在沙箱内实测 DNS/HTTPS 并给出判定，`#沙箱诊断 预览` 只看配置实际下发什么。白名单只写 IP/CIDR 时 E2B 不会自动放行 DNS(8.8.8.8:53)，此时沙箱内域名解析会失败（`allowOut` 里请写域名）。

---

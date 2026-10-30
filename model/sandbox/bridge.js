/**
 * 内置工具的沙箱执行桥 —— 「宿主 shell 类工具改走 E2B」的统一入口。
 *
 * 背景（产品约定）：`agent.sandbox.mode=e2b` 表示执行面已显式选择 E2B 隔离沙箱；
 * 凡此前在宿主 spawn/execFile 的内置工具（calculate / web_download / transcribe_media /
 * file_to_pdf / install_skill），一律改在会话沙箱内执行：
 *   - mode=off（或未配置沙箱）→ 调用方走宿主路径（行为与旧版一致）；
 *   - mode=e2b 且沙箱就绪 → 在会话沙箱内执行（与本会话 terminal 共用同一 microVM）；
 *   - mode=e2b 但沙箱不可用 → 调用方必须 fail-closed 拒绝（**绝不回落宿主**）。
 *
 * 例外：web_crawl 的 crawl4ai 是**本机引擎**（宿主 venv，与 diagram 的本机 Kroki 同类），
 * 默认不受 sandbox.mode 影响；仅当 `agent.kb.crawl.execution=sandbox` 显式选择时才走会话沙箱
 * （见 model/crawl/index.js 的 resolveCrawlExecution）。
 *
 * 沙箱内的命令一律由插件拼装：固定 argv 片段 + shellQuote 引用的动态参数（URL/文件名等），
 * 不把不可信字符串直接拼进命令串；用户内容与宿主密钥都不进沙箱。
 *
 * 命令同样计入 agent.sandbox.maxCommandsPerSession（与 terminal 共享同一会话计数），
 * 防止「下载/转换」类长任务绕过成本闸。
 */
import { openSandboxBundle } from './bundle.js'
import { sessionKeyOf } from './index.js'
import Log from '../../utils/Log.js'

/** 沙箱执行面是否被显式选择（mode=e2b；不看 manager 是否就绪） */
export function sandboxSelected(ctx) {
  return String(ctx?.sandbox?.mode || 'off').toLowerCase() === 'e2b'
}

/**
 * 解析工具可用的会话执行面（manager 未就绪 → null，由调用方按 sandboxSelected 决定 fail-closed）。
 * 契约与 terminal 的 ctx.sandbox 同源（apps/agent.js 装配）。
 * @returns {null|{mode:string, manager:object, key:string, commands:object|null, maxTimeout:number, defaultCwd:string, audit:boolean}}
 */
export function toolSandbox(ctx) {
  const s = ctx?.sandbox || {}
  const manager = s.manager || null
  if (!manager) return null
  return {
    mode: String(s.mode || 'off').toLowerCase(),
    manager,
    // 会话键缺失时按身份自算（与 terminal 同源，保证同一会话共用同一沙箱）
    key: String(s.sessionKey || sessionKeyOf(ctx || {})),
    commands: s.commands || null,
    maxTimeout: Math.max(1, Number(s.maxTimeout) || 600),
    defaultCwd: String(s.defaultCwd || '/home/user'),
    audit: s.audit !== false,
  }
}

/** 显式选择 e2b 但执行面不可用：结构化 fail-closed 失败（调用方直接返回给模型） */
export function sandboxUnavailableError(label = '本工具') {
  return {
    error: `沙箱不可用，已拒绝在宿主执行（fail-closed）：${label} 需要 E2B 沙箱执行面，`
      + '当前沙箱未就绪（agent.sandbox.mode=e2b 但初始化失败/连不上）。'
      + '请检查配置与 E2B 连通性，保存配置或 #agent重载 重建运行时后重试。',
  }
}

/**
 * 打开一次工具用的沙箱会话（复用会话沙箱；本工具不销毁沙箱，交给闲置回收）。
 * @param {ReturnType<typeof toolSandbox>} box
 * @param {{purpose:string, cwd?:string, files?:Array<{path:string,data:string|Uint8Array}>}} opt
 */
export async function openToolSession(box, { purpose, cwd = null, files = null } = {}) {
  return openSandboxBundle(box.manager, box.key, {
    files: files || [],
    execCwd: cwd || box.defaultCwd,
    oneShot: false,
    purpose: purpose || 'tool',
  })
}

/**
 * 计成本闸（与 terminal 共享会话计数）并执行一条命令。
 * @returns {Promise<{ok, exitCode, stdout, stderr, duration, sandboxId, timedOut?, aborted?, sandboxError?, limited?, error?}>}
 *   limited=true 表示被成本闸拒绝（未执行）
 */
export async function runToolCommand(box, sess, command, { timeoutMs = 60000, maxOutput = 8000, signal = null, cwd = null, label = 'tool' } = {}) {
  const cmd = String(command ?? '')
  if (box.commands?.hit?.(box.key)) {
    return {
      ok: false, exitCode: null, stdout: '', stderr: '', duration: 0, limited: true,
      error: `本会话命令数已达上限（${box.commands.limit} 条，agent.sandbox.maxCommandsPerSession）。可用 #新会话 开新会话，或调高该上限。`,
    }
  }
  if (box.audit) {
    try { Log.mark('[sandbox-tool]', `label=${label} key=${box.key} $ ${cmd.slice(0, 200)}`) } catch { /* noop */ }
  }
  return sess.run(cmd, { timeoutMs, maxOutput, signal, cwd: cwd || undefined })
}

/** 沙箱内命令不存在（exit 127=未找到 / 126=不可执行）：给模板缺依赖的可读失败 */
export function missingCommand(bin, r, toolName = '本工具') {
  const code = Number(r?.exitCode)
  if (code !== 127 && code !== 126) return null
  return {
    error: `沙箱内${code === 126 ? '无法执行' : '没有'} \`${bin}\`（${toolName} 需要它）。请把它装进 agent.sandbox.template 指向的 E2B 模板后重试`
      + `（沙箱执行面已显式选择 e2b，不会回落到宿主执行）。`,
    missing: bin,
  }
}

export { sandboxTmp, shellQuote } from './bundle.js'

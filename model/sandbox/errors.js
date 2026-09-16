/**
 * 沙箱失败分类与结构化失败返回（唯一真源）。
 *
 * 三条硬约束（审计「失败不得冒充成功」）：
 *   1. 「命令非零退出」是业务语义，**不是**基础设施故障——由调用方按 exitCode 处理，
 *      绝不在这里折成 SandboxError（否则会把"命令失败"误报成"沙箱坏了"）。
 *   2. 任何 SandboxError 落到工具层必须是 ok:false + exitCode:null，不允许出现 ok:true。
 *   3. 本文件**不接触 `e2b` 包**（按错误形态判定），因此可在未安装/未联网环境被单测覆盖。
 */

/** 失败分类全集（顺序即优先级，classify 按此表判定） */
export const FAIL_KINDS = ['unconfigured', 'unreachable', 'auth', 'template_missing', 'quota', 'timeout', 'killed', 'protocol', 'unknown']

/** 可重试类（由上层决定是否重试；沙箱层自身绝不"重试到本地"） */
export const RETRYABLE_KINDS = new Set(['unreachable', 'quota'])

/** 面向用户/模型的默认文案（SandboxError 自带的 message 优先） */
const KIND_TEXT = {
  unconfigured: '沙箱未配置，已拒绝执行（需 agent.sandbox.mode=e2b 且填 apiKey）',
  unreachable: 'E2B 沙箱服务不可达（检查 agent.sandbox.apiUrl / 网络 / 代理）',
  auth: 'E2B 认证失败（检查 agent.sandbox.apiKey 是否有效）',
  template_missing: '沙箱模板不可用或过旧（检查 agent.sandbox.template）',
  quota: 'E2B 配额或并发已满，请稍后重试',
  timeout: '沙箱命令超时',
  killed: '沙箱已被回收或执行被取消',
  protocol: '沙箱返回了无法解析的结果',
  unknown: '沙箱执行失败',
}

export class SandboxError extends Error {
  constructor(kind, message, { retryable = null, detail = null, cause = null } = {}) {
    super(message || KIND_TEXT[kind] || KIND_TEXT.unknown)
    this.name = 'SandboxError'
    this.kind = FAIL_KINDS.includes(kind) ? kind : 'unknown'
    this.retryable = retryable == null ? RETRYABLE_KINDS.has(this.kind) : !!retryable
    this.detail = detail
    if (cause) this.cause = cause
  }
}

/** 输出截断（文案与宿主实现保持一致，替换执行面时用户可见行为不变） */
export function truncateOutput(s, max = 8000) {
  const t = String(s == null ? '' : s)
  const n = Number(max) > 0 ? Number(max) : 8000
  if (t.length <= n) return t
  return t.slice(0, n) + `\n…[已截断，共 ${t.length} 字符]`
}

/**
 * 是否为「命令非零退出」错误（CommandExitError 形态）。
 * 不 import e2b：优先按 name，其次按 CommandResult 三字段形态判定（跨版本稳健）。
 */
export function isExitError(err) {
  if (!err || typeof err !== 'object') return false
  if (err.name === 'CommandExitError') return true
  return typeof err.exitCode === 'number' && typeof err.stdout === 'string' && typeof err.stderr === 'string'
}

/**
 * 任意异常 → 失败分类。
 * @returns {{kind:string, retryable:boolean, detail:string}|null} null＝业务退出码（非基础设施故障）
 */
export function classify(err) {
  if (err instanceof SandboxError) return { kind: err.kind, retryable: err.retryable, detail: err.detail || err.message }
  if (isExitError(err)) return null
  const name = String(err?.name || '')
  const code = String(err?.code || '')
  const status = Number(err?.status ?? err?.statusCode ?? 0)
  const msg = String(err?.message || err || '')
  const hay = `${name} ${code} ${msg}`

  // 未配置（本地就能判定的错误，别伪装成网络故障）
  if (/E2B_API_KEY|api key is required|not configured|missing api key|未配置/i.test(hay)) return { kind: 'unconfigured', retryable: false, detail: msg }
  // 认证
  if (name === 'AuthenticationError' || status === 401 || status === 403 || /unauthor|forbidden|invalid api key/i.test(hay)) return { kind: 'auth', retryable: false, detail: msg }
  // 配额/并发
  if (name === 'RateLimitError' || name === 'ServiceBusyError' || status === 429 || /rate limit|too many requests|quota|busy/i.test(hay)) return { kind: 'quota', retryable: true, detail: msg }
  // 模板
  if (name === 'TemplateError' || /template.*(not found|missing|update|invalid)/i.test(hay)) return { kind: 'template_missing', retryable: false, detail: msg }
  // 沙箱已不存在（TTL 回收 / 被 kill）——上层可重建一次
  if (name === 'SandboxNotFoundError' || /sandbox.*not found|no such sandbox|已回收/i.test(hay)) return { kind: 'killed', retryable: false, detail: msg }
  // 超时
  if (name === 'TimeoutError' || /timeout|timed out|deadline exceeded/i.test(hay)) return { kind: 'timeout', retryable: false, detail: msg }
  // 主动取消
  if (name === 'AbortError' || /aborted/i.test(hay)) return { kind: 'killed', retryable: false, detail: msg }
  // 不可达
  if (['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code) || /fetch failed|network|socket hang up|getaddrinfo/i.test(hay)) {
    return { kind: 'unreachable', retryable: true, detail: msg }
  }
  return { kind: 'unknown', retryable: false, detail: msg }
}

/** 是否为基础设施故障（业务退出码返回 false） */
export function isSandboxInfra(err) {
  return classify(err) !== null
}

/**
 * 异常 → 工具层结构化失败结果（超集：旧契约只有 {ok,stderr,duration}）。
 * 不变式：ok===false 且 exitCode===null 且带 sandboxError。
 */
export function toToolFailure(err, { maxOutput = 8000, duration = 0, sandboxId = null } = {}) {
  const info = classify(err) || { kind: 'unknown', retryable: false, detail: null }
  const text = err instanceof SandboxError ? err.message : (KIND_TEXT[info.kind] || KIND_TEXT.unknown)
  const out = {
    ok: false,
    exitCode: null,
    stdout: '',
    stderr: truncateOutput(`${text}${info.detail ? `：${info.detail}` : ''}`, maxOutput),
    duration,
    sandboxError: { kind: info.kind, retryable: info.retryable },
  }
  if (sandboxId) out.sandboxId = sandboxId
  return out
}

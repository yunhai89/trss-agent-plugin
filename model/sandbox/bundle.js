/**
 * 沙箱「文件包 + 命令」执行原语 —— toolEvo（候选验证/stable 工具调用）与内置工具的沙箱执行面共用。
 *
 * 与 runSandboxShell 的区别：那条面向「终端会话的任意命令」，这条面向「一组文件 + 固定入口命令，
 * 可跑多次」的脚本包（上传一次、执行 N 次），避免每个用例重复上传/重复冷启动。
 *
 * 两条使用形态：
 *   - 会话复用（oneShot=false）：绑定固定 key 到会话沙箱，产物留在沙箱内供后续调用；
 *   - 一次性（oneShot=true）：唯一 key + close() 直接销毁，用于跑不可信的候选代码。
 *
 * 文件进出：write/writeMany（小文本）、upload（宿主大文件流式上传）、read（小文本读回）、
 * downloadTo（沙箱文件流式落盘宿主，带字节上限与取消）；list 供产物收集。
 */
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'

import { SandboxError, classify, toToolFailure, truncateOutput } from './errors.js'

let _seq = 0

/** POSIX shell 单引号安全引用（与 shlex.quote 同形）：命令串里拼动态参数时用，杜绝注入。 */
export function shellQuote(value) {
  const s = String(value ?? '')
  if (s === '') return "''"
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s
  return `'${s.replace(/'/g, "'\\''")}'`
}

/** 沙箱内工具临时目录（每次调用一个；宿主路径在沙箱里无意义） */
export function sandboxTmp(name = 'tool') {
  const safe = String(name || 'tool').replace(/[^\w-]/g, '').slice(0, 24) || 'tool'
  return `/home/user/.agent-tmp/${safe}-${Date.now().toString(36)}-${++_seq}`
}

/** 字节数的人类可读形态（上限报错用） */
function fmtBytes(n) {
  const v = Number(n) || 0
  return v >= 1048576 ? `${Math.round(v / 1048576)}MB` : `${v}B`
}

/**
 * 打开一个脚本包会话。
 * @param {object} manager SandboxManager
 * @param {string} key 会话键（oneShot=true 时仅作前缀）
 * @param {object} opts { files: [{path,data}], execCwd, envs, oneShot, purpose }
 * @returns {Promise<{ run, close, sandboxId }>}
 */
export async function openSandboxBundle(manager, key, { files = [], execCwd = '/home/user/evo', oneShot = false, purpose = null } = {}) {
  if (!manager) throw new SandboxError('unconfigured', '沙箱不可用（未配置或初始化失败）')
  const bindKey = oneShot ? `${key || 'oneshot'}#${++_seq}` : String(key)
  const handle = await manager.acquire(bindKey, { purpose: purpose || (oneShot ? 'toolEvo-verify' : 'toolEvo-runner') })
  const absFiles = (files || []).map((f) => ({ path: f.path.startsWith('/') ? f.path : `${execCwd}/${f.path}`, data: f.data }))
  if (absFiles.length) await manager.transport.writeMany(handle, absFiles)

  const session = {
    sandboxId: handle.id,
    key: bindKey,
    /** 追加写入文件（制品按需上传；同一会话内可多次调用） */
    async write({ path: p, data }) {
      const abs = String(p).startsWith('/') ? String(p) : `${execCwd}/${p}`
      await manager.transport.write(handle, abs, data)
      return abs
    },
    /**
     * 跑一条命令。
     * @returns {Promise<{ok, exitCode, stdout, stderr, duration, timedOut?, aborted?, sandboxError?}>}
     */
    async run(command, { runEnvs = null, timeoutMs = 5000, maxOutput = 8192, signal = null, cwd = execCwd } = {}) {
      const t0 = Date.now()
      if (signal?.aborted) return { ok: false, exitCode: null, stdout: '', stderr: '', duration: 0, aborted: true }
      try {
        const result = await new Promise((resolve, reject) => {
          let stdout = ''
          let stderr = ''
          let cmdHandle = null
          let timer = null
          let onAbort = null
          let done = false
          const cleanup = () => { if (timer) clearTimeout(timer); if (onAbort && signal) signal.removeEventListener('abort', onAbort) }
          const finish = (r) => { if (done) return; done = true; cleanup(); resolve(r) }
          const fail = (e) => { if (done) return; done = true; cleanup(); reject(e) }
          const killCmd = () => { try { const p = cmdHandle?.kill?.(); p?.catch?.(() => {}) } catch { /* noop */ } }
          timer = setTimeout(() => { killCmd(); finish({ ok: false, exitCode: null, signal: 'SIGKILL', timedOut: true }) }, timeoutMs)
          if (signal) {
            onAbort = () => { killCmd(); finish({ ok: false, exitCode: null, signal: 'SIGKILL', aborted: true }) }
            if (signal.aborted) onAbort()
            else signal.addEventListener('abort', onAbort, { once: true })
          }
          Promise.resolve()
            .then(() => manager.transport.run(handle, String(command), {
              cwd,
              envs: runEnvs || undefined,
              // 服务端兜底比本地 timer 宽 5s：本地先到给出 timedOut 语义，网关卡死时由 envd 终止
              timeoutMs: timeoutMs + 5000,
              onStdout: (d) => { stdout += String(d) },
              onStderr: (d) => { stderr += String(d) },
            }))
            .then((h) => { cmdHandle = h; return h.wait() })
            .then((res) => {
              const code = Number(res?.exitCode ?? 0)
              finish({ ok: code === 0, exitCode: code, stdout: String(res?.stdout ?? '') || stdout, stderr: String(res?.stderr ?? '') || stderr })
            })
            .catch((e) => {
              if (e && typeof e.exitCode === 'number' && typeof e.stdout === 'string') {
                finish({ ok: e.exitCode === 0, exitCode: e.exitCode, stdout: e.stdout || stdout, stderr: e.stderr || stderr })
                return
              }
              fail(e)
            })
        })
        return { ...result, stdout: truncateOutput(result.stdout, maxOutput), stderr: truncateOutput(result.stderr, maxOutput), duration: Date.now() - t0, sandboxId: handle.id }
      } catch (e) {
        return toToolFailure(e, { maxOutput: Math.min(maxOutput, 2000), duration: Date.now() - t0, sandboxId: handle.id })
      }
    },

    /** 关闭：一次性会话销毁沙箱；复用会话仅归还租约（等闲置回收） */
    async close() {
      if (!oneShot) return false
      try { return await manager.destroy(bindKey) } catch { return false }
    },
  }

  /** 绝对化沙箱内路径（相对 execCwd） */
  const absOf = (p) => (String(p).startsWith('/') ? String(p) : `${execCwd}/${p}`)

  /** 读沙箱内文件：默认文本；binary=true → Buffer（小文件用；大文件请 downloadTo） */
  session.read = async (p, { binary = false } = {}) => {
    const data = await manager.transport.read(handle, absOf(p), { format: binary ? 'bytes' : 'text' })
    return binary ? Buffer.from(data) : String(data)
  }

  /** 列目录（depth=1 仅本级；递归收集产物时调大） */
  session.list = async (dir, { depth = 1 } = {}) => manager.transport.list(handle, absOf(dir), { depth })

  /**
   * 宿主 → 沙箱 流式上传（大文件不整块进内存）。
   * @returns {Promise<{path:string, bytes:number}>}
   */
  session.upload = async (hostPath, remotePath, { maxBytes = null } = {}) => {
    const st = fs.statSync(hostPath)
    if (maxBytes && st.size > maxBytes) {
      throw new SandboxError('unknown', `文件超过沙箱上传上限（${fmtBytes(st.size)} > ${fmtBytes(maxBytes)}）`)
    }
    const abs = absOf(remotePath)
    try {
      await manager.transport.write(handle, abs, Readable.toWeb(fs.createReadStream(hostPath)))
    } catch (e) {
      throw ensureSandboxError(e, '上传到沙箱失败')
    }
    return { path: abs, bytes: st.size }
  }

  /**
   * 沙箱 → 宿主 流式落盘（大文件不整块进内存）+ 字节上限 + 取消；失败清理半成品文件。
   * @returns {Promise<{path:string, bytes:number}>}
   */
  session.downloadTo = async (remotePath, hostPath, { maxBytes = null, signal = null } = {}) => {
    const abs = absOf(remotePath)
    if (signal?.aborted) throw new SandboxError('killed', '下载已取消')
    let webStream
    try {
      webStream = await manager.transport.read(handle, abs, { format: 'stream', signal })
    } catch (e) {
      throw ensureSandboxError(e, '读取沙箱文件失败')
    }
    const src = Readable.fromWeb(webStream)
    fs.mkdirSync(path.dirname(hostPath), { recursive: true })
    const out = fs.createWriteStream(hostPath)
    let bytes = 0
    let settled = false
    let rejectFn = null
    const cleanup = () => { try { signal?.removeEventListener?.('abort', onAbort) } catch { /* noop */ } }
    const settleFail = (e) => {
      if (settled) return
      settled = true
      cleanup()
      try { src.destroy() } catch { /* noop */ }
      try { out.destroy() } catch { /* noop */ }
      rejectFn?.(e)
    }
    const onAbort = () => settleFail(new SandboxError('killed', '下载已取消'))
    try {
      await new Promise((resolve, reject) => {
        rejectFn = reject
        if (signal) {
          if (signal.aborted) { settleFail(new SandboxError('killed', '下载已取消')); return }
          signal.addEventListener('abort', onAbort, { once: true })
        }
        src.on('data', (chunk) => {
          bytes += chunk.length
          if (maxBytes && bytes > maxBytes) settleFail(new SandboxError('unknown', `文件超过下载上限（${fmtBytes(bytes)} > ${fmtBytes(maxBytes)}）`))
        })
        src.on('error', (e) => settleFail(ensureSandboxError(e, '沙箱文件读取中断')))
        out.on('error', (e) => settleFail(e))
        out.on('finish', () => {
          if (settled) return
          settled = true
          cleanup()
          resolve()
        })
        src.pipe(out)
      })
    } catch (e) {
      try { fs.rmSync(hostPath, { force: true }) } catch { /* noop */ }
      throw e
    }
    return { path: hostPath, bytes }
  }
  return session
}

/** 一次性执行一个脚本包（等价 open + run + close，供只需单次调用的场景） */
export async function runSandboxBundle(manager, key, { command, files, envs, timeoutMs, maxOutput, execCwd, purpose } = {}) {
  const session = await openSandboxBundle(manager, key, { files, execCwd, oneShot: true, purpose })
  try {
    return await session.run(command, { runEnvs: envs, timeoutMs, maxOutput })
  } finally {
    await session.close()
  }
}

/** 把沙箱失败折成 SandboxError（保留 kind），供 toolEvo 统一处理 */
export function ensureSandboxError(e, prefix) {
  if (e instanceof SandboxError) return e
  const info = classify(e) || { kind: 'unknown', retryable: false, detail: null }
  return new SandboxError(info.kind, `${prefix}：${info.detail || '未知原因'}`, { retryable: info.retryable, cause: e })
}

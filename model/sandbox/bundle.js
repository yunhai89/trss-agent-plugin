/**
 * 沙箱「文件包 + 命令」执行原语 —— toolEvo 的候选验证与 stable 工具调用共用。
 *
 * 与 runSandboxShell 的区别：那条面向「终端会话的任意命令」，这条面向「一组文件 + 固定入口命令，
 * 可跑多次」的脚本包（上传一次、执行 N 次），避免每个用例重复上传/重复冷启动。
 *
 * 两条使用形态：
 *   - 会话复用（oneShot=false）：绑定固定 key 到会话沙箱，产物留在沙箱内供后续调用；
 *   - 一次性（oneShot=true）：唯一 key + close() 直接销毁，用于跑不可信的候选代码。
 */
import { SandboxError, classify, toToolFailure, truncateOutput } from './errors.js'

let _seq = 0

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

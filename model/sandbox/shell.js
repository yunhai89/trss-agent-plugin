/**
 * `runShell` 契约的沙箱实现 —— terminal 工具**唯一**的 shell 执行面（宿主 spawn 已删除）。
 *
 * 返回形状与旧宿主实现逐字段对齐（调用方零改动）：
 *   { ok, exitCode, stdout, stderr, duration, signal?, timedOut?, aborted? }
 * 并附加 `setupMs`（acquire 耗时）与 `sandboxId`；失败路径返回 errors.js 的结构化失败。
 *
 * 安全语义（与本仓「不降级到更危险执行面」一致）：
 *   - 拿不到沙箱 → 直接失败，**不存在任何本地执行的兜底分支**。
 *   - 只在「命令确定未启动」时重建沙箱重试一次；命令已启动后失败**绝不重跑**
 *     （任意 shell 命令可能有副作用，重跑等于重复已确认副作用）。
 */
import { SandboxError, classify, toToolFailure, truncateOutput } from './errors.js'

/**
 * @param {import('./manager.js').SandboxManager} manager
 * @param {string} key 会话绑定键（同键复用同一沙箱）
 * @param {string} command
 * @param {object} [opts] { cwd, timeout(秒), maxOutput, signal, maxTimeout(秒上限), defaultCwd, envs }
 */
export async function runSandboxShell(manager, key, command, {
  cwd,
  timeout = 60,
  maxOutput = 8000,
  signal = null,
  maxTimeout = 600,
  defaultCwd = '/home/user',
  envs = null,
} = {}) {
  const cmd = String(command == null ? '' : command)
  const seconds = Math.min(Math.max(1, Number(timeout) || 60), Math.max(1, Number(maxTimeout) || 600))
  const ms = seconds * 1000
  const bindKey = String(key || 'default')
  const t0 = Date.now()

  // 已被取消：连沙箱都不创建（不为一次注定被丢弃的调用付创建成本）
  if (signal?.aborted) {
    return { ok: false, exitCode: null, signal: 'SIGKILL', stdout: '', stderr: '', duration: 0, aborted: true }
  }
  if (!cmd.trim()) return { ok: false, exitCode: null, stdout: '', stderr: '空命令', duration: 0 }
  if (!manager) return toToolFailure(new SandboxError('unconfigured', '沙箱不可用，已拒绝执行'), { maxOutput, duration: Date.now() - t0 })

  let started = false // 命令是否已真正启动（决定能否安全重建重试）
  let sandboxId = null

  for (let attempt = 0; ; attempt++) {
    const acquireT0 = Date.now()
    let handle = null
    try {
      handle = await manager.acquire(bindKey, { purpose: 'shell' })
      sandboxId = handle.id
    } catch (e) {
      // acquire 失败＝命令从未启动：沙箱刚被回收时可重建一次（先 drop 掉死租约）
      if (attempt === 0 && classify(e)?.kind === 'killed') { manager.drop(bindKey); continue }
      return toToolFailure(e, { maxOutput: Math.min(maxOutput, 2000), duration: Date.now() - t0 })
    }
    const setupMs = Date.now() - acquireT0
    const commandT0 = Date.now()

    try {
      const result = await new Promise((resolve, reject) => {
        let stdout = ''
        let stderr = ''
        let cmdHandle = null
        let timer = null
        let onAbort = null
        let done = false
        const cleanup = () => {
          if (timer) clearTimeout(timer)
          if (onAbort && signal) signal.removeEventListener('abort', onAbort)
        }
        const finish = (r) => { if (done) return; done = true; cleanup(); resolve(r) }
        const fail = (e) => { if (done) return; done = true; cleanup(); reject(e) }
        // kill 是尽力而为：沙箱即使没杀掉也会随 TTL 回收，不因此改变本次结果
        const killCmd = () => { try { const p = cmdHandle?.kill?.(); p?.catch?.(() => {}) } catch { /* noop */ } }

        timer = setTimeout(() => {
          killCmd()
          finish({ ok: false, exitCode: null, signal: 'SIGKILL', timedOut: true })
        }, ms)
        if (signal) {
          onAbort = () => {
            killCmd()
            finish({ ok: false, exitCode: null, signal: 'SIGKILL', aborted: true })
          }
          if (signal.aborted) onAbort()
          else signal.addEventListener('abort', onAbort, { once: true })
        }

        Promise.resolve()
          // 服务端兜底超时比本地 timer 宽 5s：本地先到时能给出 timedOut 语义，
          // 网关卡死时由 envd 侧终止，避免把超时误判成 protocol/unknown
          .then(() => manager.transport.run(handle, cmd, {
            cwd: cwd || defaultCwd,
            envs,
            timeoutMs: ms + 5000,
            onStdout: (d) => { stdout += String(d) },
            onStderr: (d) => { stderr += String(d) },
          }))
          .then((h) => { cmdHandle = h; started = true; return h.wait() })
          .then((res) => {
            const code = Number(res?.exitCode ?? 0)
            finish({
              ok: code === 0,
              exitCode: code,
              stdout: String(res?.stdout ?? '') || stdout,
              stderr: String(res?.stderr ?? '') || stderr,
            })
          })
          .catch((e) => {
            // 命令已启动后失败：绝不重跑（可能有副作用），原样按业务退出码上报
            if (e && typeof e.exitCode === 'number' && typeof e.stdout === 'string') {
              finish({ ok: e.exitCode === 0, exitCode: e.exitCode, stdout: e.stdout || stdout, stderr: e.stderr || stderr })
              return
            }
            fail(e)
          })
      })

      return {
        ...result,
        stdout: truncateOutput(result.stdout, maxOutput),
        stderr: truncateOutput(result.stderr, maxOutput),
        duration: Date.now() - commandT0,
        setupMs,
        sandboxId,
      }
    } catch (e) {
      const duration = Date.now() - commandT0
      // 只在「命令确实没起来」且沙箱已消失时重建一次
      if (attempt === 0 && !started && classify(e)?.kind === 'killed') { manager.drop(bindKey); continue }
      return toToolFailure(e, { maxOutput: Math.min(maxOutput, 2000), duration, sandboxId })
    }
  }
}

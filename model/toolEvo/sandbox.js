/**
 * 候选工具执行器（阶段2）：**双档**执行后端。
 *
 *   本地档（默认 / agent.sandbox.mode=off）：node 子进程跑候选，临时目录 + 超时 SIGKILL + 输出截断。
 *   沙箱档（agent.sandbox.mode=e2b）：候选在 E2B microVM 里跑，出口全关，跑完即毁。
 *
 * 安全模型（纵深，两档共用前置门）：
 *   1. 前置门：typescript AST 已禁 require/child_process/process.env/eval/动态 import/一切 import
 *      （verifier/static.js）→ 候选是纯函数，无 import、不接触宿主环境；
 *   2. 执行隔离：本地档=子进程（零 docker 依赖、可靠）；沙箱档=microVM（真实边界，防 AST 绕过）；
 *   3. 不向子进程/沙箱透传敏感 env（本地档仅 TOOL_INPUT_JSON + PATH/HOME；沙箱档连宿主 env 都不存在）。
 *
 * 对外暴露「会话」形态（一个候选 = 一个会话，多个用例复用），避免每个用例重复上传/冷启动：
 *   createLocalCandidateSession({ source, timeoutMs })  -> { run, close }
 *   createSandboxCandidateSession(verifyManager, { source, timeoutMs, maxOutput }) -> { run, close }
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { openSandboxBundle } from '../sandbox/bundle.js'

/** 测试驱动：动态 import 候选 index.js 的 run，跑 input，输出 JSON 结果 */
const RUNNER = `
const inp = JSON.parse(process.env.TOOL_INPUT_JSON || '{}')
const ctx = { requestId: 'verify', now: () => new Date().toISOString(), log() {} }
import('./index.js').then(async ({ run }) => {
  if (typeof run !== 'function') return process.stdout.write(JSON.stringify({ ok: false, error: '未导出 run 函数' }))
  try { const out = await run(inp, ctx); process.stdout.write(JSON.stringify({ ok: true, output: out })) }
  catch (e) { process.stdout.write(JSON.stringify({ ok: false, error: e?.message || String(e), errorClass: e?.name || 'Error' })) }
}).catch(e => process.stdout.write(JSON.stringify({ ok: false, error: '加载候选失败：' + (e?.message || e) })))
`

/** 统一把「原始输出文本 + 退出码」折成结果对象（两档共用，保证文案一致） */
function foldOutput(raw, { exitCode, duration, maxOutput, stderr }) {
  if (raw.timedOut) return { ok: false, error: `执行超时(>${raw.timeoutMs}ms，疑似死循环)`, timedOut: true, duration, stderr: String(stderr || '').slice(0, 512) }
  if (raw.spawnError) return { ok: false, error: '子进程启动失败：' + raw.spawnError, duration }
  if (raw.sandboxError) return { ok: false, error: `沙箱执行失败(${raw.sandboxError.kind})：${String(raw.stderr || '').slice(0, 300)}`, duration, stderr: String(stderr || '').slice(0, 512) }
  try {
    const out = JSON.parse(String(raw.stdout || '').slice(0, maxOutput))
    return { ok: !!out.ok, output: out.output, error: out.error, errorClass: out.errorClass, exitCode, duration, stderr: String(stderr || '').slice(0, 512) }
  } catch {
    return { ok: false, error: '候选输出非 JSON（或未正确 return）：' + String(raw.stdout || '').slice(0, 200), exitCode, duration, stderr: String(stderr || '').slice(0, 512) }
  }
}

/** 本地档会话：临时目录写 bundle，每个用例 spawn 一次 node */
export async function createLocalCandidateSession({ source, timeoutMs = 3000, maxOutput = 8192 }) {
  const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tevo-verify-'))
  fs.writeFileSync(path.join(bundleDir, 'index.js'), String(source || ''))
  fs.writeFileSync(path.join(bundleDir, 'runner.mjs'), RUNNER)
  const env = { TOOL_INPUT_JSON: '', PATH: process.env.PATH || '', HOME: process.env.HOME || '' }
  return {
    backend: 'local',
    async run({ input, timeoutMs: t = timeoutMs, maxOutput: mo = maxOutput } = {}) {
      const ms = Math.max(500, Number(t) || 3000)
      const t0 = Date.now()
      const r = await new Promise((resolve) => {
        const e = { ...env, TOOL_INPUT_JSON: JSON.stringify(input ?? {}) }
        const proc = spawn(process.execPath, ['runner.mjs'], { cwd: bundleDir, env: e, stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = '', stderr = ''
        const timer = setTimeout(() => {
          try { proc.kill('SIGKILL') } catch { /* noop */ }
          resolve({ timedOut: true, timeoutMs: ms, stdout, stderr })
        }, ms)
        proc.stdout?.on('data', (d) => { stdout += d.toString() })
        proc.stderr?.on('data', (d) => { stderr += d.toString() })
        proc.on('error', (err) => { clearTimeout(timer); resolve({ spawnError: err.message, stdout, stderr }) })
        proc.on('close', (code) => { clearTimeout(timer); resolve({ exitCode: code, stdout, stderr }) })
      })
      return foldOutput(r, { exitCode: r.exitCode, duration: Date.now() - t0, maxOutput: mo, stderr: r.stderr })
    },
    async close() {
      try { fs.rmSync(bundleDir, { recursive: true, force: true }) } catch { /* noop */ }
    },
  }
}

/** 沙箱档会话：一个候选一个一次性 microVM（出口全关），多个用例复用同一沙箱 */
export async function createSandboxCandidateSession(verifyManager, { source, timeoutMs = 3000, maxOutput = 8192 }) {
  const bundle = await openSandboxBundle(verifyManager, 'tevo-verify', {
    files: [{ path: 'index.js', data: String(source || '') }, { path: 'runner.mjs', data: RUNNER }],
    oneShot: true,
    purpose: 'toolEvo-verify',
  })
  return {
    backend: 'sandbox',
    sandboxId: bundle.sandboxId,
    async run({ input, timeoutMs: t = timeoutMs, maxOutput: mo = maxOutput } = {}) {
      const r = await bundle.run('node runner.mjs', {
        runEnvs: { TOOL_INPUT_JSON: JSON.stringify(input ?? {}) },
        timeoutMs: Math.max(500, Number(t) || 3000),
        maxOutput: mo,
      })
      return foldOutput(r, { exitCode: r.exitCode, duration: r.duration, maxOutput: mo, stderr: r.stderr })
    },
    async close() { await bundle.close() },
  }
}

/**
 * 跑一次候选（保留原有入口：内部用一个会话跑一个用例）。
 * @param {object} p { source, input, timeoutMs?, maxOutput?, createSession? }
 */
export async function runCandidate({ source, input, timeoutMs = 3000, maxOutput = 8192, createSession = null }) {
  const factory = createSession || createLocalCandidateSession
  const session = await factory({ source, timeoutMs, maxOutput })
  try {
    return await session.run({ input, timeoutMs, maxOutput })
  } finally {
    await session.close()
  }
}

export default { runCandidate, createLocalCandidateSession, createSandboxCandidateSession }

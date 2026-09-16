/**
 * toolEvo stable 工具执行 runner —— **双档**（审计 §4.2 / P0-1，F 阻断级）。
 *
 * 背景：stable 进化工具原在 Bot 主进程直接 `import` 执行并传入完整 ctx（含 e/bot/fetcher）。
 * 审计探针证明 `Function('return process')().env` 可读宿主 env、`fetch(input.url)` 可联网、
 * `ctx.bot.pickGroup().sendMsg()` 可发消息——AST 门拦不住运行时动态逃逸。
 *
 * 两档都不在主进程执行工具代码：
 *   本地档（默认 / agent.sandbox.mode=off）：常驻 node 子进程（runner-worker.mjs）+ IPC，
 *     子进程内构造冻结 capabilityCtx = {now, log}，env 最小化（仅 PATH/HOME），崩溃自愈 + 超时 kill。
 *   沙箱档（agent.sandbox.mode=e2b）：工具代码在 E2B microVM 内的一次性会话沙箱里跑，
 *     连宿主 env 都不存在；制品按 versionId 上传一次并缓存，参数经文件传递（不走 shell 拼接）。
 *
 * 串行队列（toolEvo 低频）在两档共用，避免并发竞争。
 */
import { fork } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

import { openSandboxBundle } from '../sandbox/bundle.js'

const WORKER = fileURLToPath(new URL('./runner-worker.mjs', import.meta.url))
const RESTART_MIN_MS = 1000 // 崩溃重启最小间隔（防循环）
const SANDBOX_KEY = 'toolEvo:runner'
const SANDBOX_CWD = '/home/user/evo'
const MAX_OUTPUT = 8192

/** 沙箱内的执行入口：读 EVO_ENTRY + params 文件，跑 run(params, 冻结 ctx)，输出单行 JSON */
const SANDBOX_ENTRY = `
import fs from 'node:fs'
const params = JSON.parse(fs.readFileSync(process.env.EVO_PARAMS_FILE, 'utf8') || '{}')
const ctx = Object.freeze({ now: () => new Date().toISOString(), log() {} })
import(process.env.EVO_ENTRY).then(async (mod) => {
  if (typeof mod.run !== 'function') return process.stdout.write(JSON.stringify({ ok: false, error: '未导出 run 函数' }))
  try { const out = await mod.run(params, ctx); process.stdout.write(JSON.stringify({ ok: true, output: out })) }
  catch (e) { process.stdout.write(JSON.stringify({ ok: false, error: e?.message || String(e), errorClass: e?.name || 'Error' })) }
}).catch(e => process.stdout.write(JSON.stringify({ ok: false, error: '加载工具制品失败：' + (e?.message || e) })))
`

export class RunnerClient {
  /**
   * @param {object} opt { logger, timeoutMs, sandbox?, artifactsDir? }
   *   sandbox = createSandboxRuntime() 的返回对象（需 manager）→ 启用沙箱档；缺省走本地 fork 档
   *   artifactsDir：制品根目录（沙箱档据此把宿主绝对路径换算成沙箱内相对路径）
   */
  constructor({ logger = () => {}, timeoutMs = 5000, sandbox = null, artifactsDir = null } = {}) {
    this.logger = logger
    this.timeoutMs = timeoutMs
    this.sandbox = sandbox
    this.artifactsDir = artifactsDir
    this._worker = null
    this._pending = new Map() // id → { resolve, timer }
    this._lastRestart = 0
    this._closed = false
    this._lock = Promise.resolve() // 串行队列（toolEvo 工具低频，避免 id/PID 竞争）
    this._session = null // 沙箱档：会话（懒开）
    this._uploaded = new Map() // versionId → true（当前会话已上传制品）
  }

  /** 当前执行档（日志/测试用） */
  get backend() { return this.sandbox?.manager ? 'sandbox' : 'local' }

  // ── 本地档：常驻 node 子进程 + IPC ──
  _spawn() {
    if (this._closed || this._worker) return
    // env 最小化：绝不透传 apiKey/proxy/cookie 等敏感变量（审计 §4.2）
    const env = { PATH: process.env.PATH || '', HOME: process.env.HOME || '' }
    const w = fork(WORKER, [], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    w.on('message', (msg) => {
      if (msg?.type === 'log') { this.logger('debug', '[toolEvo:runner] worker log:', ...(msg.args || [])); return }
      const p = this._pending.get(msg?.id)
      if (!p) return
      this._pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.ok) p.resolve({ ok: true, output: msg.output })
      else p.resolve({ ok: false, error: msg.error || '执行失败', errorClass: msg.errorClass })
    })
    w.on('exit', (code, signal) => {
      this.logger('warn', `[toolEvo:runner] worker 退出 code=${code} signal=${signal}`)
      this._failAll(`worker 退出（code=${code}）`)
      this._worker = null
      this._maybeRestart()
    })
    w.on('error', (e) => {
      this.logger('error', '[toolEvo:runner] worker error', e?.message || e)
      this._failAll(`worker error：${e?.message || e}`)
      this._worker = null
      this._maybeRestart()
    })
    w.stdout?.on('data', (d) => this.logger('debug', '[toolEvo:runner] stdout:', d.toString().trim()))
    w.stderr?.on('data', (d) => this.logger('warn', '[toolEvo:runner] stderr:', d.toString().trim()))
    this._worker = w
  }

  _maybeRestart() {
    if (this._closed) return
    const now = Date.now()
    if (now - this._lastRestart < RESTART_MIN_MS) return // 限频
    this._lastRestart = now
    this._spawn()
  }

  _failAll(reason) {
    for (const [id, p] of this._pending) {
      clearTimeout(p.timer)
      p.resolve({ ok: false, error: reason })
      this._pending.delete(id)
    }
  }

  _ensure() {
    if (!this._worker) this._spawn()
    return this._worker
  }

  /**
   * 调用 stable 工具（串行 + 超时；本地档崩溃自愈，沙箱档失败即弃会话重建）。
   * @returns {Promise<{ok, output?, error?, errorClass?}>}
   */
  async invoke(versionId, { artifactPath, artifactRel = null, params }, { timeoutMs } = {}) {
    if (this._closed) return { ok: false, error: 'runner 已关闭' }
    // 串行锁：避免并发 invoke 竞争（本地档 IPC id / 沙箱档 params 文件）
    await this._lock
    let release
    this._lock = new Promise((r) => { release = r })
    try {
      return this.backend === 'sandbox'
        ? await this._invokeSandbox(versionId, { artifactPath, artifactRel, params }, timeoutMs)
        : await this._invokeOnce(artifactPath, params, timeoutMs)
    } finally {
      release()
    }
  }

  // ── 沙箱档 ──
  async _ensureSession() {
    if (this._session) return this._session
    const session = await openSandboxBundle(this.sandbox.manager, SANDBOX_KEY, {
      files: [{ path: 'runner.mjs', data: SANDBOX_ENTRY }],
      execCwd: SANDBOX_CWD,
      purpose: 'toolEvo-runner',
    })
    this._session = session
    this._uploaded.clear() // 新沙箱没有旧制品
    return session
  }

  /** 宿主制品路径 → 沙箱内相对路径（registry 给 artifactRel 时优先用它） */
  _relOf(artifactPath, artifactRel) {
    if (artifactRel) return String(artifactRel).split(/[\\/]/).filter(Boolean).join('/')
    if (!this.artifactsDir || !artifactPath) return null
    const abs = String(artifactPath).startsWith('file:') ? fileURLToPath(artifactPath) : String(artifactPath)
    const rel = String(abs).startsWith(this.artifactsDir) ? abs.slice(this.artifactsDir.length) : ''
    const clean = rel.split(/[\\/]/).filter(Boolean).join('/')
    return clean || null
  }

  async _invokeSandbox(versionId, { artifactPath, artifactRel, params }, timeoutMs) {
    const ms = Math.max(500, Number(timeoutMs) || this.timeoutMs)
    const rel = this._relOf(artifactPath, artifactRel)
    if (!rel) return { ok: false, error: '无法定位工具制品（缺 artifactRel/artifactsDir），已拒绝在沙箱外执行' }
    const entry = `${SANDBOX_CWD}/${rel}`
    try {
      const session = await this._ensureSession()
      if (!this._uploaded.has(versionId)) {
        // 只在首次调用该版本时读宿主文件并上传；之后复用沙箱内副本
        const absHost = String(artifactPath || '').startsWith('file:') ? fileURLToPath(artifactPath) : artifactPath
        const source = fs.readFileSync(absHost, 'utf8')
        await session.write({ path: rel, data: source })
        this._uploaded.set(versionId, true)
      }
      await session.write({ path: 'params.json', data: JSON.stringify(params ?? {}) })
      const r = await session.run('node runner.mjs', {
        runEnvs: { EVO_ENTRY: entry, EVO_PARAMS_FILE: `${SANDBOX_CWD}/params.json` },
        timeoutMs: ms,
        maxOutput: MAX_OUTPUT,
      })
      if (r.timedOut) return { ok: false, error: `执行超时(>${ms}ms，疑似死循环/网络等待)` }
      if (r.aborted) return { ok: false, error: '执行被取消' }
      if (r.sandboxError) return { ok: false, error: `沙箱执行失败(${r.sandboxError.kind})：${String(r.stderr || '').slice(0, 300)}` }
      try {
        const out = JSON.parse(String(r.stdout || '').trim().slice(0, MAX_OUTPUT))
        return out.ok ? { ok: true, output: out.output } : { ok: false, error: out.error || '执行失败', errorClass: out.errorClass }
      } catch {
        return { ok: false, error: '工具输出非 JSON：' + String(r.stdout || '').slice(0, 200) }
      }
    } catch (e) {
      // 沙箱不可用/会话失效：丢弃会话（下次重建），本次调用如实失败——**不回退本地执行**
      await this._dropSandbox()
      return { ok: false, error: `沙箱不可用：${e?.message || e}` }
    }
  }

  async _dropSandbox() {
    const key = this._session?.key || SANDBOX_KEY
    this._session = null
    this._uploaded.clear()
    try { await this.sandbox?.manager?.destroy(key) } catch { /* noop */ }
  }

  // ── 本地档：单次 IPC 调用 ──
  _invokeOnce(artifactPath, params, timeoutMs) {
    return new Promise((resolve) => {
      const id = randomBytes(6).toString('hex')
      const ms = Math.max(500, Number(timeoutMs) || this.timeoutMs)
      const timer = setTimeout(() => {
        this._pending.delete(id)
        this.logger('warn', `[toolEvo:runner] 调用超时(>${ms}ms)，kill+重启 worker`)
        try { this._worker?.kill('SIGKILL') } catch { /* noop */ }
        this._worker = null
        this._maybeRestart()
        resolve({ ok: false, error: `执行超时(>${ms}ms，疑似死循环/网络等待)` })
      }, ms)
      this._pending.set(id, { resolve, timer })
      const w = this._ensure()
      if (!w) {
        clearTimeout(timer); this._pending.delete(id)
        resolve({ ok: false, error: 'worker 启动失败' })
        return
      }
      try {
        w.send({ id, artifactPath, params })
      } catch (e) {
        clearTimeout(timer); this._pending.delete(id)
        resolve({ ok: false, error: 'IPC 发送失败：' + (e?.message || e) })
      }
    })
  }

  async stop() {
    this._closed = true
    this._failAll('runner 关闭')
    if (this._worker) { try { this._worker.kill() } catch { /* noop */ } this._worker = null }
    await this._dropSandbox()
  }
}

export default RunnerClient

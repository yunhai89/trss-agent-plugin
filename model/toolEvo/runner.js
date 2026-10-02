/**
 * toolEvo stable 工具执行 runner —— **双档**（审计 §4.2 / P0-1）。
 *
 * 两档都不在主进程执行工具代码：
 *   本地档（agent.sandbox.mode=off）：隔离子进程（unshare -n 网络命名空间 + node --permission
 *     只读权限），capabilityCtx = 冻结 {now, log}，env 最小化；隔离不可用直接 fail-closed。
 *   沙箱档（agent.sandbox.mode=e2b）：E2B microVM 内一次性会话，出口**全关**（不继承 terminal 白名单）；
 *     显式选择 e2b 后即使 manager 初始化失败也绝不降级本地。
 *
 * 串行队列（审计 P1-6）：等待前同步挂到队列尾，保证同 tick 并发峰值恒为 1；支持取消/关闭/预算。
 * 制品完整性（审计 P1-7）：执行前校验宿主制品文件哈希 == 验证时的 content_hash，不匹配即拒绝；
 * 实际执行的是 DB 里不可变的 source 字节，杜绝“校验后重新读取”竞态。
 */
import { spawn } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { openSandboxBundle } from '../sandbox/bundle.js'
import { isolatedNodeCommand } from './isolation.js'

const WORKER = fileURLToPath(new URL('./runner-worker.mjs', import.meta.url))
const RESTART_MIN_MS = 1000
const SANDBOX_KEY = 'toolEvo:runner'
const SANDBOX_CWD = '/home/user/evo'
const MAX_OUTPUT = 8192
const DEFAULT_MEM_MB = 128

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
   * @param {object} opt { logger, timeoutMs, sandbox?, artifactsDir?, memoryMb? }
   *   sandbox: { mode:'off'|'e2b', manager } 或 { manager }。manager 缺失且 mode=e2b → 永久不可用（fail-closed）。
   */
  constructor({ logger = () => {}, timeoutMs = 5000, sandbox = null, artifactsDir = null, memoryMb = DEFAULT_MEM_MB } = {}) {
    this.logger = logger
    this.timeoutMs = timeoutMs
    this.sandbox = sandbox
    this.artifactsDir = artifactsDir
    this.memoryMb = Math.max(16, Number(memoryMb) || DEFAULT_MEM_MB)
    this._worker = null
    this._workerGen = 0
    this._pending = new Map() // id → { resolve, timer, gen }
    this._lastRestart = 0
    this._closed = false
    this._lock = Promise.resolve()
    this._session = null
    this._uploaded = new Map()
    this._workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tevo-run-'))
    this._materialized = new Map() // contentHash → path
  }

  /** 当前执行档 */
  get backend() {
    if (this.sandbox?.manager) return 'sandbox'
    if (String(this.sandbox?.mode || '').toLowerCase() === 'e2b') return 'sandbox-unavailable'
    return 'local'
  }

  // ── 本地档：隔离常驻子进程 + IPC ──
  _spawn() {
    if (this._closed || this._worker || this._localUnavailable) return
    const launch = isolatedNodeCommand({
      fsReadPaths: [this._workDir, path.dirname(WORKER)],
      nodeFlags: [`--max-old-space-size=${this.memoryMb}`],
    })
    if (!launch) {
      this._localUnavailable = true
      this.logger('warn', '[toolEvo:runner] 本地隔离面不可用（缺 unshare 或权限模型），本地档拒绝执行')
      return
    }
    const gen = ++this._workerGen
    const env = { PATH: process.env.PATH || '', HOME: process.env.HOME || '' }
    // 用 spawn 直接跑 `unshare <flags> node <perm flags> WORKER`；stdio 保留 'ipc'，
    // unshare exec 后 node 继承 NODE_CHANNEL_FD，IPC 通道可用。
    const w = spawn(launch.command, [...launch.args, WORKER], {
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    const onMessage = (msg) => {
      if (msg?.type === 'log') { this.logger('debug', '[toolEvo:runner] worker log:', ...(msg.args || [])); return }
      const p = this._pending.get(msg?.id)
      if (!p || p.gen !== gen) return
      this._pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.ok) p.resolve({ ok: true, output: msg.output })
      else p.resolve({ ok: false, error: msg.error || '执行失败', errorClass: msg.errorClass })
    }
    w.on('message', onMessage)
    w.on('exit', (code, signal) => {
      this.logger('warn', `[toolEvo:runner] worker 退出 code=${code} signal=${signal}`)
      if (this._worker === w) { this._worker = null }
      this._failAll(`worker 退出（code=${code}）`, gen)
      if (w._recycled) return // 用后即弃：不重启（防跨调用状态残留）
      this._maybeRestart()
    })
    w.on('error', (e) => {
      this.logger('error', '[toolEvo:runner] worker error', e?.message || e)
      if (this._worker === w) { this._worker = null }
      this._failAll(`worker error：${e?.message || e}`, gen)
      if (w._recycled) return
      this._maybeRestart()
    })
    w.stdout?.on('data', (d) => this.logger('debug', '[toolEvo:runner] stdout:', d.toString().trim()))
    w.stderr?.on('data', (d) => this.logger('warn', '[toolEvo:runner] stderr:', d.toString().trim()))
    w._evoGen = gen
    this._worker = w
  }

  _maybeRestart() {
    if (this._closed) return
    const now = Date.now()
    if (now - this._lastRestart < RESTART_MIN_MS) return
    this._lastRestart = now
    this._spawn()
  }

  /** 用后即弃：杀掉当前 worker，不重启——保证跨调用/跨工具无残留状态（审计 P0-1） */
  _recycleWorker() {
    const w = this._worker
    this._worker = null
    if (!w) return
    w._recycled = true
    try { w.kill('SIGKILL') } catch { /* noop */ }
  }

  _failAll(reason, gen) {
    for (const [id, p] of this._pending) {
      if (gen != null && p.gen !== gen) continue
      clearTimeout(p.timer)
      p.resolve({ ok: false, error: reason, errorClass: 'worker_exit' })
      this._pending.delete(id)
    }
  }

  _ensure() {
    if (!this._worker) this._spawn()
    return this._worker
  }

  /** 把不可变 source 落到只读的私有工作目录（worker 在权限模型下只读） */
  _materialize(source, expectedHash) {
    const h = expectedHash || createHash('sha256').update(String(source || '')).digest('hex')
    if (this._materialized.has(h)) return this._materialized.get(h)
    const file = path.join(this._workDir, `${h}.mjs`)
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, String(source || ''))
      try { fs.chmodSync(file, 0o444) } catch { /* noop */ }
    }
    this._materialized.set(h, file)
    return file
  }

  /** 校验宿主制品文件哈希（制品篡改/半写入 → 拒绝执行） */
  _verifyArtifact(artifactPath, expectedHash) {
    if (!expectedHash || !artifactPath) return true
    try {
      const abs = String(artifactPath).startsWith('file:') ? fileURLToPath(artifactPath) : String(artifactPath)
      const data = fs.readFileSync(abs)
      const h = createHash('sha256').update(data).digest('hex')
      return h === expectedHash
    } catch { return false }
  }

  /**
   * 调用 stable 工具（串行 + 超时 + 取消；本地档崩溃自愈，沙箱档失败即弃会话重建）。
   * @returns {Promise<{ok, output?, error?, errorClass?}>}
   */
  async invoke(versionId, { source, artifactPath, artifactRel = null, expectedHash = null, params }, { timeoutMs, signal, taskId } = {}) {
    // 串行调度：等待前同步入队，保证同 tick 并发峰值 1（审计 P1-6）
    const prev = this._lock
    let release
    this._lock = new Promise((r) => { release = r })
    await prev
    try {
      if (this._closed) return { ok: false, error: 'runner 已关闭', errorClass: 'closed' }
      if (signal?.aborted) return { ok: false, error: '执行被取消', errorClass: 'cancelled' }
      if (this.backend === 'sandbox-unavailable') {
        return { ok: false, error: '沙箱执行面不可用（已显式选择 e2b，拒绝降级本地执行）', errorClass: 'sandbox_unavailable' }
      }
      return this.backend === 'sandbox'
        ? await this._invokeSandbox(versionId, { source, artifactPath, artifactRel, expectedHash, params }, { timeoutMs, signal })
        : await this._invokeOnce(versionId, { source, artifactPath, expectedHash, params }, { timeoutMs, signal, taskId })
    } finally {
      // 用后即弃：本地档每次调用后回收 worker；沙箱档每次调用后销毁会话——杜绝跨调用/跨工具
      // 因常驻 worker 或共享沙箱遗留状态而泄露数据（审计 P0-1）。
      if (this.backend === 'local') this._recycleWorker()
      else await this._dropSandbox().catch(() => {})
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
    this._uploaded.clear()
    return session
  }

  _relOf(artifactPath, artifactRel) {
    if (artifactRel) return String(artifactRel).split(/[\\/]/).filter(Boolean).join('/')
    if (!this.artifactsDir || !artifactPath) return null
    const abs = String(artifactPath).startsWith('file:') ? fileURLToPath(artifactPath) : String(artifactPath)
    const rel = String(abs).startsWith(this.artifactsDir) ? abs.slice(this.artifactsDir.length) : ''
    const clean = rel.split(/[\\/]/).filter(Boolean).join('/')
    return clean || null
  }

  async _invokeSandbox(versionId, { source, artifactPath, artifactRel, expectedHash, params }, { timeoutMs, signal }) {
    const ms = Math.max(500, Number(timeoutMs) || this.timeoutMs)
    // 上传前校验宿主制品哈希，拒绝篡改/半写入
    if (!this._verifyArtifact(artifactPath, expectedHash)) {
      return { ok: false, error: '工具制品哈希不匹配（已被篡改或半写入），拒绝执行', errorClass: 'artifact_tampered' }
    }
    const rel = this._relOf(artifactPath, artifactRel)
    if (!rel) return { ok: false, error: '无法定位工具制品（缺 artifactRel/artifactsDir），已拒绝在沙箱外执行', errorClass: 'artifact_missing' }
    const entry = `${SANDBOX_CWD}/${rel}`
    const uploadKey = `${versionId}:${expectedHash || 'src'}`
    const paramsRel = `params-${randomBytes(6).toString('hex')}.json`
    try {
      const session = await this._ensureSession()
      if (!this._uploaded.has(uploadKey)) {
        const content = String(source ?? '')
        if (!content) {
          if (!artifactPath) return { ok: false, error: '缺少可执行的不可变 source，拒绝执行', errorClass: 'artifact_missing' }
          const absHost = String(artifactPath).startsWith('file:') ? fileURLToPath(artifactPath) : artifactPath
          await session.write({ path: rel, data: fs.readFileSync(absHost, 'utf8') })
        } else {
          await session.write({ path: rel, data: content })
        }
        this._uploaded.set(uploadKey, true)
      }
      await session.write({ path: paramsRel, data: JSON.stringify(params ?? {}) })
      const r = await session.run('node runner.mjs', {
        runEnvs: { EVO_ENTRY: entry, EVO_PARAMS_FILE: `${SANDBOX_CWD}/${paramsRel}` },
        timeoutMs: ms,
        maxOutput: MAX_OUTPUT,
        signal: signal || null,
      })
      if (r.timedOut) { await this._dropSandbox(); return { ok: false, error: `执行超时(>${ms}ms，疑似死循环/网络等待)`, errorClass: 'timeout' } }
      if (r.aborted) { await this._dropSandbox(); return { ok: false, error: '执行被取消', errorClass: 'cancelled' } }
      if (r.sandboxError) { await this._dropSandbox(); return { ok: false, error: `沙箱执行失败(${r.sandboxError.kind})：${String(r.stderr || '').slice(0, 300)}`, errorClass: 'sandbox_error' } }
      try {
        const out = JSON.parse(String(r.stdout || '').trim().slice(0, MAX_OUTPUT))
        return out.ok ? { ok: true, output: out.output } : { ok: false, error: out.error || '执行失败', errorClass: out.errorClass }
      } catch {
        return { ok: false, error: '工具输出非 JSON：' + String(r.stdout || '').slice(0, 200), errorClass: 'bad_output' }
      }
    } catch (e) {
      await this._dropSandbox()
      return { ok: false, error: `沙箱不可用：${e?.message || e}`, errorClass: 'sandbox_unavailable' }
    }
  }

  async _dropSandbox() {
    const key = this._session?.key || SANDBOX_KEY
    this._session = null
    this._uploaded.clear()
    try { await this.sandbox?.manager?.destroy(key) } catch { /* noop */ }
  }

  // ── 本地档：单次 IPC 调用（隔离 worker） ──
  _invokeOnce(versionId, { source, artifactPath, expectedHash, params }, { timeoutMs, signal, taskId }) {
    if (!this._verifyArtifact(artifactPath, expectedHash)) {
      return Promise.resolve({ ok: false, error: '工具制品哈希不匹配（已被篡改或半写入），拒绝执行', errorClass: 'artifact_tampered' })
    }
    return new Promise((resolve) => {
      const id = randomBytes(6).toString('hex')
      const ms = Math.max(500, Number(timeoutMs) || this.timeoutMs)
      let settled = false
      const done = (r) => { if (!settled) { settled = true; resolve(r) } }
      const p = this._pending
      const w = this._ensure()
      if (!w) {
        done({ ok: false, error: '本地隔离面不可用，拒绝执行不可信工具', errorClass: 'isolation_unavailable' })
        return
      }
      const gen = w._evoGen
      const onAbort = () => {
        clearTimeout(timer)
        p.delete(id)
        if (this._worker === w) this._recycleWorker()
        done({ ok: false, error: '执行被取消', errorClass: 'cancelled' })
      }
      if (signal) {
        if (signal.aborted) { onAbort(); return }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      const timer = setTimeout(() => {
        p.delete(id)
        if (signal) signal.removeEventListener?.('abort', onAbort)
        if (this._worker === w) this._recycleWorker()
        done({ ok: false, error: `执行超时(>${ms}ms，疑似死循环/网络等待)`, errorClass: 'timeout' })
      }, ms)
      p.set(id, { resolve: (r) => { if (signal) signal.removeEventListener?.('abort', onAbort); done(r) }, timer, gen })
      try {
        // 有不可变 source 时落到私有只读工作目录并执行它；否则回退到宿主制品路径（兼容/测试）
        const artifactFile = source ? this._materialize(source, expectedHash) : artifactPath
        w.send({ id, artifactPath: artifactFile, params, taskId: taskId || null })
      } catch (e) {
        clearTimeout(timer); p.delete(id)
        if (signal) signal.removeEventListener?.('abort', onAbort)
        done({ ok: false, error: 'IPC 发送失败：' + (e?.message || e), errorClass: 'ipc_error' })
      }
    })
  }

  async stop() {
    this._closed = true
    this._failAll('runner 关闭')
    if (this._worker) { try { this._worker.kill('SIGKILL') } catch { /* noop */ } this._worker = null }
    await this._dropSandbox()
    try { fs.rmSync(this._workDir, { recursive: true, force: true }) } catch { /* noop */ }
  }
}

export default RunnerClient

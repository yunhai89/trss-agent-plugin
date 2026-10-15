/**
 * 执行面接线回归（离线）——web_crawl 工具在「沙箱模式开启」时 crawl4ai 到底跑在哪。
 * 运行：node model/crawl/crawl4ai.execution.test.mjs
 *
 * 断言（子进程内跑：Config 桩与模块级探测缓存不污染本进程）：
 *  ① 默认（未配 kb.crawl.execution）+ agent.sandbox.mode=e2b：**仍在宿主**跑 crawl4ai
 *     （桩 venv python 真被调用、结果 via=crawl4ai、会话沙箱 0 条命令）——crawl4ai 是与
 *     diagram 本机 Kroki 同类的本地引擎，不随沙箱模式进 E2B；
 *  ② kb.crawl.execution=sandbox + mode=e2b：改在会话沙箱内执行（桩 transport 收命令），宿主桩不再被调用；
 *  ③ kb.crawl.execution=sandbox + mode=off（配置矛盾）：按本地执行 + 可读提示，不静默失败。
 *
 * 跨平台：宿主桩用 POSIX shell 脚本（Windows 跳过本文件的接线块，纯逻辑断言仍在 crawl4ai.test.mjs）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }

console.log('\n[执行面接线：默认本地（不随 sandbox.mode 进沙箱）]')
if (process.platform === 'win32') {
  console.log('  · SKIP（Windows 无 POSIX shell 桩；逻辑断言见 crawl4ai.test.mjs）')
} else {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crawl-exec-'))
  try {
    // ── 宿主 venv 桩：探测（-c）回版本；抓取（脚本参数 + stdin 请求）落 marker 并回单行 JSON 协议 ──
    const MARK = path.join(TMP, 'host-ran.txt')
    const venvDir = path.join(TMP, 'venv')
    fs.mkdirSync(path.join(venvDir, 'bin'), { recursive: true })
    const fakePython = path.join(venvDir, 'bin', 'python3')
    fs.writeFileSync(fakePython, [
      '#!/bin/sh',
      'if [ "$1" = "-c" ]; then echo "9.9.9"; exit 0; fi',
      'echo "HOST" >> "$CRAWL_MARK"',
      'cat > /dev/null',
      `printf '%s\\n' '{"ok":true,"url":"http://93.184.216.34/","title":"宿主桩","markdown":"HOST-MARKDOWN","status_code":200}'`,
      '',
    ].join('\n'))
    fs.chmodSync(fakePython, 0o755)

    // ── 子进程脚本：Config 可换 → 依次跑三种配置，回传观测 ──
    const urls = {
      config: pathToFileURL(path.join(import.meta.dirname, '..', '..', 'utils', 'Config.js')).href,
      tool: pathToFileURL(path.join(import.meta.dirname, 'index.js')).href,
      manager: pathToFileURL(path.join(import.meta.dirname, '..', 'sandbox', 'manager.js')).href,
      sandboxIndex: pathToFileURL(path.join(import.meta.dirname, '..', 'sandbox', 'index.js')).href,
    }
    const child = `
import fs from 'node:fs'
import Config from ${JSON.stringify(urls.config)}
import { webCrawlTool } from ${JSON.stringify(urls.tool)}
import { SandboxManager } from ${JSON.stringify(urls.manager)}
import { makeCommandCounter } from ${JSON.stringify(urls.sandboxIndex)}

// 兜底 fetch 桩：任何意外降级都不得真的出网
globalThis.fetch = async () => ({
  ok: true, status: 200, headers: { get: () => 'text/html; charset=utf-8' },
  async arrayBuffer() { return Buffer.from('<html><head><title>F</title></head><body>' + 'f'.repeat(200) + '</body></html>') },
})

const transport = {
  calls: { create: 0, run: 0, cmds: [] },
  async init() { return this },
  async ping() { return true },
  async create() { this.calls.create++; return { id: 'sbx-exec-1', raw: {} } },
  async connect() { return { id: 'sbx-exec-1', raw: {} } },
  async run(_h, cmd) {
    this.calls.run++; this.calls.cmds.push(cmd)
    if (/-c\\s/.test(cmd)) return { async wait() { return { exitCode: 0, stdout: '0.7.4\\n', stderr: '' } }, async kill() { return true } }
    if (/^rm -rf /.test(cmd)) return { async wait() { return { exitCode: 0, stdout: '', stderr: '' } }, async kill() { return true } }
    return { async wait() { return { exitCode: 0, stdout: JSON.stringify({ ok: true, url: 'http://93.184.216.34/', title: '沙箱桩', markdown: 'SANDBOX-MARKDOWN', status_code: 200 }) + '\\n', stderr: '' } }, async kill() { return true } }
  },
  async write() {}, async writeMany() {}, async read() { return '' }, async list() { return [] },
  async kill() { return true }, async setTimeout() {}, async updateNetwork() {},
}
const box = new SandboxManager({ transport, idleMs: 60000, sandboxTtlMs: 600000, sweepIntervalMs: 100000 })
const ctx = (mode) => ({ sandbox: { mode, manager: mode === 'e2b' ? box : null, sessionKey: 'k-exec', commands: makeCommandCounter(50), maxTimeout: 600, defaultCwd: '/home/user', audit: false } })
const readMark = () => { try { return fs.readFileSync(process.env.CRAWL_MARK, 'utf8') } catch { return '' } }

const origGet = Config.get
const setCfg = (execution) => { Config.get = () => ({ agent: { kb: execution ? { crawl: { execution } } : {} } }) }
const out = {}
try {
  setCfg(null) // ① 默认
  out.byDefault = await webCrawlTool.execute({ url: 'http://93.184.216.34/face-1' }, ctx('e2b'))
  out.markAfterDefault = readMark()
  out.sandboxRunsAfterDefault = transport.calls.run

  setCfg('sandbox') // ② 显式沙箱
  out.bySandbox = await webCrawlTool.execute({ url: 'http://93.184.216.34/face-2' }, ctx('e2b'))
  out.markAfterSandbox = readMark()
  out.sandboxRunsAfterSandbox = transport.calls.run

  setCfg('sandbox') // ③ 矛盾配置（沙箱档 + mode=off）
  out.byModeOff = await webCrawlTool.execute({ url: 'http://93.184.216.34/face-3' }, ctx('off'))
  out.markAfterModeOff = readMark()
  out.sandboxRunsAfterModeOff = transport.calls.run
} finally {
  Config.get = origGet
  await box.shutdown()
}
process.stdout.write('__RESULT__' + JSON.stringify(out) + '\\n')
`
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', child], {
      cwd: path.join(import.meta.dirname, '..', '..'),
      encoding: 'utf8',
      timeout: 60000,
      env: { ...process.env, CRAWL4AI_VENV: venvDir, CRAWL_MARK: MARK },
    })
    const line = String(r.stdout || '').split('\n').find((l) => l.startsWith('__RESULT__'))
    if (!line) {
      failed++
      console.error('  ✗ FAIL 子进程未回传结果', `status=${r.status}`, String(r.stderr || '').slice(-800), String(r.stdout || '').slice(-400))
    } else if (r.status !== 0) {
      // 子进程非零退出仍按失败计（防止「断言没跑却算过」）
      failed++
      console.error('  ✗ FAIL 子进程非零退出', r.status, String(r.stderr || '').slice(-800))
    } else {
      const out = JSON.parse(line.slice('__RESULT__'.length))
      // ① 默认：宿主 venv crawl4ai
      ok(out.byDefault?.ok === true && out.byDefault?.via === 'crawl4ai', `默认档结果来自 crawl4ai（via=${out.byDefault?.via}）`)
      ok(String(out.byDefault?.text || '').includes('HOST-MARKDOWN'), '默认档正文来自宿主 venv 桩（真跑了宿主 python）')
      ok(out.markAfterDefault === 'HOST\n', '宿主桩被调用一次（marker 落盘）')
      ok(out.sandboxRunsAfterDefault === 0, `默认档不触达会话沙箱（沙箱命令数 ${out.sandboxRunsAfterDefault}）`)
      // ② execution=sandbox：沙箱内执行，宿主桩不再被调用
      ok(String(out.bySandbox?.text || '').includes('SANDBOX-MARKDOWN'), '沙箱档结果来自沙箱桩（沙箱执行面生效）')
      ok(out.bySandbox?.via === 'crawl4ai', '沙箱档 via=crawl4ai')
      ok(out.markAfterSandbox === 'HOST\n', '沙箱档不跑宿主 crawl4ai（marker 未增长）')
      ok(out.sandboxRunsAfterSandbox > 0, `沙箱档在沙箱内执行（沙箱命令数 ${out.sandboxRunsAfterSandbox}）`)
      // ③ execution=sandbox 但 mode=off：按本地（矛盾配置不静默失败）
      ok(String(out.byModeOff?.text || '').includes('HOST-MARKDOWN'), 'mode=off 时按本地执行（宿主桩命中）')
      ok(out.markAfterModeOff === 'HOST\nHOST\n', '宿主桩再被调用一次（矛盾配置回落本地且有提示）')
      ok(out.sandboxRunsAfterModeOff === out.sandboxRunsAfterSandbox, 'mode=off 不动沙箱')
    }
  } finally {
    fs.rmSync(TMP, { recursive: true, force: true })
  }
}

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1

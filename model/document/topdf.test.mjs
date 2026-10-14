/**
 * file_to_pdf 沙箱档自检（桩 transport；无需 e2b / LibreOffice / 联网）。
 * 运行：node model/document/topdf.test.mjs
 *
 * 覆盖：
 *   - 沙箱档：探测 soffice → 上传输入 → 沙箱内转换 → 产物流式拉回
 *   - 模板缺 soffice：不传大文件（探测先失败）→ 可读失败点名模板
 *   - 工具层：mode=e2b 但沙箱未就绪 + docx（纯 JS 不可转）→ 拒绝在宿主跑 soffice
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import { runSofficeInSandbox, fileToPdfTool } from './topdf.js'
import { SandboxManager } from '../sandbox/manager.js'
import { makeCommandCounter } from '../sandbox/index.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `  (got ${JSON.stringify(a)}，期望 ${JSON.stringify(b)})`}`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack) } }

function makeHandle({ exitCode = 0, stdout = '', stderr = '' } = {}) {
  return { async wait() { return { exitCode, stdout, stderr } }, async kill() { return true } }
}
function stubTransport({ probeOk = true, pdf = 'pdf-bytes' } = {}) {
  const calls = { create: 0, run: 0, cmds: [], writes: [], reads: [] }
  let seq = 0
  return {
    calls,
    async init() { return this },
    async ping() { return true },
    async create() { calls.create++; return { id: `sbx-${++seq}`, raw: {} } },
    async connect() { return { id: 'c', raw: {} } },
    async run(h, cmd, opts) {
      calls.run++; calls.cmds.push(cmd)
      if (/command -v soffice/.test(cmd)) return makeHandle({ exitCode: probeOk ? 0 : 1 })
      return makeHandle({ exitCode: 0 })
    },
    async write(_h, p, data) { calls.writes.push({ path: p, stream: typeof data?.getReader === 'function' }) },
    async writeMany() {},
    async read(_h, p, { format } = {}) {
      calls.reads.push({ path: p, format })
      if (format === 'stream') return Readable.toWeb(Readable.from([Buffer.from(pdf)]))
      return pdf
    },
    async list() { return [] },
    async kill() { return true }, async setTimeout() {}, async updateNetwork() {},
  }
}
const mkBox = (t) => new SandboxManager({ transport: t, idleMs: 60000, sandboxTtlMs: 600000, sweepIntervalMs: 100000 })
const boxOf = (box) => ({ manager: box, key: 'k-pdf', commands: makeCommandCounter(50), maxTimeout: 600, defaultCwd: '/home/user', audit: false })

await test('沙箱档：上传 → 沙箱内 soffice → 产物拉回', async () => {
  const t = stubTransport()
  const box = mkBox(t)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topdf-sbx-'))
  const input = path.join(dir, 'report.docx')
  fs.writeFileSync(input, 'fake docx')
  const outPath = path.join(dir, 'out.pdf')
  try {
    const r = await runSofficeInSandbox(boxOf(box), input, { outPath })
    eq(r.path, outPath, '返回拉回的 PDF 路径')
    eq(r.sandbox, true, '标注沙箱执行面')
    eq(t.calls.cmds[0], 'command -v soffice >/dev/null 2>&1', '先探测（缺 soffice 不必上传大文件）')
    ok(t.calls.writes.some((w) => w.path.endsWith('/in.docx')), '输入按扩展名上传到沙箱 in.docx')
    ok(/^soffice --headless --convert-to pdf --outdir \/home\/user\/\.agent-tmp\/topdf-[\w-]+ \/home\/user\/\.agent-tmp\/topdf-[\w-]+\/in\.docx$/.test(t.calls.cmds[1]), `转换命令为固定 argv 拼装（${t.calls.cmds[1]}）`)
    eq(t.calls.reads[0].format, 'stream', 'PDF 流式拉回')
    ok(t.calls.reads[0].path.endsWith('/in.pdf'), '按可预测的产物名读取')
    eq(fs.readFileSync(outPath, 'utf8'), 'pdf-bytes', 'PDF 内容落地正确')
  } finally { await box.shutdown(); fs.rmSync(dir, { recursive: true, force: true }) }
})

await test('沙箱档：模板缺 soffice → 探测即失败，不上传输入', async () => {
  const t = stubTransport({ probeOk: false })
  const box = mkBox(t)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topdf-sbx-'))
  const input = path.join(dir, 'report.docx')
  fs.writeFileSync(input, 'fake docx')
  try {
    const r = await runSofficeInSandbox(boxOf(box), input, { outPath: path.join(dir, 'out.pdf') })
    ok(r.error && r.error.includes('soffice') && r.error.includes('模板'), '错误点名缺 soffice + 提示装模板')
    eq(r.missing, 'soffice', '标记 missing')
    eq(t.calls.writes.length, 0, '未上传输入（探测先失败）')
    eq(t.calls.run, 1, '只执行了探测命令')
  } finally { await box.shutdown(); fs.rmSync(dir, { recursive: true, force: true }) }
})

await test('工具层：mode=e2b 但沙箱未就绪 + docx → 拒绝在宿主跑 soffice', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topdf-fc-'))
  const input = path.join(dir, 'report.docx')
  fs.writeFileSync(input, 'fake docx')
  try {
    const r = await fileToPdfTool.execute({ path: input }, { sandbox: { mode: 'e2b', manager: null } })
    ok(r.error && r.error.includes('沙箱未就绪') && r.error.includes('soffice'), `拒绝并说明原因（${r.error}）`)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1

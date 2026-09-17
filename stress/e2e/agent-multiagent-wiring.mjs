/**
 * 接线回归：multiagent.topology 切换（spawn 异步三件套 / orchestrator 同步 orchestrate 工具），
 * 以及流式发射器 makeDeltaStreamer 的节流与全文拼接。
 *
 * 走真实 buildRuntime（离线：只构造 tool registry，不发请求）。配置热加载后应跟着切换。
 * 运行：node --import ./stress/e2e/hooks.mjs stress/e2e/agent-multiagent-wiring.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `e2e-ma-wiring-${process.pid}-`))
process.env.E2E_TMP = TMP
process.env.E2E_REAL_AGENT = '1'
await import(pathToFileURL(path.join(import.meta.dirname, 'hooks.mjs')).href)

const cfgMod = await import('./stubs/Config.js')
const { __setConfig, __emitChange } = cfgMod

let passed = 0
let failed = 0
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
const eq = (a, b, m) => ok(a === b, `${m}（实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`)

function setTopology(topology) {
  __setConfig({
    agent: {
      apiKey: 'sk-wiring-test', model: 'test-model',
      devLog: { dir: TMP + `/devlog-${topology}` },
      multiagent: { enable: true, topology },
    },
  })
}

const { getRuntime, makeDeltaStreamer } = await import('../../apps/agent.js')

console.log('\n[topology=orchestrator]')
setTopology('orchestrator')
{
  const rt = await getRuntime()
  eq(rt.tools.has('orchestrate'), true, '注册同步编排工具 orchestrate')
  eq(rt.tools.has('spawn_subagent'), false, '不注册 spawn_subagent（拓扑互斥）')
  eq(rt.tools.has('check_subagent'), false, '不注册 check_subagent')
}

console.log('\n[热加载 → topology=spawn]')
setTopology('spawn')
__emitChange()
{
  const rt = await getRuntime()
  eq(rt.tools.has('spawn_subagent'), true, '切换后注册 spawn_subagent')
  eq(rt.tools.has('check_subagent'), true, '注册 check_subagent')
  eq(rt.tools.has('extend_subagent'), true, '注册 extend_subagent')
  eq(rt.tools.has('orchestrate'), false, '不再注册 orchestrate')
}

console.log('\n[makeDeltaStreamer：节流 + 全文拼接 + 关闭时不发]')
{
  const sent = []
  const s = makeDeltaStreamer((m) => sent.push(m), { enabled: true, minIntervalMs: 0, minChars: 5 })
  s.push('你好')
  s.push('，世界')
  s.finish()
  eq(sent.join(''), '你好，世界', '增量拼接为完整文本')
  ok(s.sentAny, 'sentAny=true')
  eq(s.rawFull, '你好，世界', 'rawFull=完整原文')

  const sent2 = []
  const off = makeDeltaStreamer((m) => sent2.push(m), { enabled: false, minIntervalMs: 0, minChars: 1 })
  off.push('abc'); off.finish()
  eq(sent2.length, 0, 'enabled=false 时不发送（仅观测）')
  off.push; // no-op
  eq(off.sentAny, false, '关闭时 sentAny=false')
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exit(failed ? 1 : 0)

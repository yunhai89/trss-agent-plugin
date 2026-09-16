/**
 * 接线回归：真实 buildRuntime 下 terminal 工具的注册与 ctx.sandbox 注入（两种模式都要过）。
 * 运行：node --import ./stress/e2e/hooks.mjs stress/e2e/agent-sandbox-wiring.mjs
 *
 * 为什么需要：terminal 换成沙箱后「注册条件」与「ctx 注入」都在 apps 层，而 e2e 把 apps/agent.js
 * 整个桩掉了 → 这块装配逻辑没有任何测试覆盖。本用例走真实 buildRuntime（离线可跑：node-schedule
 * 用桩、e2b 的 init 只构造客户端不发请求），只断言接线，绝不发命令。
 *
 * 断言：
 *   mode=off  → terminal 不注册（即使残留 terminal.enable=true）、manager 为空
 *   mode=e2b  → terminal 注册、manager 就绪；配置热加载（off → e2b）后要跟着切
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `e2e-sandbox-wiring-${process.pid}-`))
process.env.E2E_TMP = TMP
process.env.E2E_REAL_AGENT = '1'
await import(pathToFileURL(path.join(import.meta.dirname, 'hooks.mjs')).href)

const cfgMod = await import('./stubs/Config.js')
const { __setConfig, __emitChange } = cfgMod

let passed = 0
let failed = 0
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }

/** 装配配置：legacyTerminal=true 模拟旧配置残留（不该因此注册工具） */
function setMode(mode, { legacyTerminal = false } = {}) {
  __setConfig({
    agent: {
      devLog: { dir: TMP + `/devlog-${mode}` },
      apiKey: 'sk-wiring-test', // 过掉 buildRuntime 的 apiKey 闸；不发任何真实请求
      model: 'test-model',
      ...(legacyTerminal ? { terminal: { enable: true, maxTimeout: 600, blocklist: [], skipConfirm: true } } : {}),
      sandbox: mode === 'e2b'
        ? { mode: 'e2b', apiKey: 'e2b_wiring_test', template: 'base', maxSandboxes: 1, idleMs: 600000, audit: false }
        : { mode: 'off' },
    },
  })
}

const { getRuntime } = await import('../../apps/agent.js')

async function assertMode(mode, { legacyTerminal = false } = {}) {
  console.log(`\n[真实 buildRuntime 接线 · mode=${mode}${legacyTerminal ? ' · 带旧 terminal.enable 残留' : ''}]`)
  setMode(mode, { legacyTerminal })
  __emitChange() // 等价真实配置热加载：invalidateRuntime → 下次 getRuntime 重建
  let rt = null
  try {
    rt = await getRuntime()
    ok(!!rt, 'buildRuntime 装配成功（离线可跑）')
  } catch (e) {
    ok(false, `buildRuntime 装配失败：${e?.message || e}`)
    return
  }
  const names = (rt.tools?.list?.() || []).map((t) => t.name)
  const expected = mode === 'e2b'
  ok(names.includes('terminal') === expected, `terminal 注册=${names.includes('terminal')}（期望 ${expected}）`)
  ok(!!rt.sandbox, 'runtime 暴露 sandbox 句柄（terminal/toolEvo 复用）')
  ok(rt.sandbox.enabled === expected, `sandbox.enabled=${rt.sandbox.enabled}（期望 ${expected}）`)
  ok((rt.sandbox.manager !== null) === expected, `manager 就绪=${rt.sandbox.manager !== null}（期望 ${expected}）`)
  ok(typeof rt.sandbox.commands?.hit === 'function', '命令数计数器就绪（成本闸）')
  if (!expected) ok(rt.sandbox.error === null, 'mode=off 是正常关闭，不是错误状态')
  // toolEvo 的执行面必须跟着模式切档：mode=off → 本地 fork；mode=e2b → 沙箱
  if (rt.toolEvo?.runner) {
    const wantBackend = expected ? 'sandbox' : 'local'
    ok(rt.toolEvo.runner.backend === wantBackend, `toolEvo runner 执行面=${rt.toolEvo.runner.backend}（期望 ${wantBackend}）`)
  } else {
    ok(false, 'toolEvo 未初始化（sqlite3 缺失？）——本用例需要它来验证执行面切换')
  }
  try { await rt.sandbox.shutdown() } catch { /* noop */ }
  try { await rt.toolEvo?.runner?.stop?.() } catch { /* noop */ }
}

await assertMode('off')
await assertMode('off', { legacyTerminal: true })
await assertMode('e2b') // off → e2b 的热加载切换

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exit(failed ? 1 : 0)

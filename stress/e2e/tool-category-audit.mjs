/**
 * 接线回归：真实 buildRuntime 下，所有注册工具必须显式声明合法 RBAC category。
 * 运行：node --import ./stress/e2e/hooks.mjs stress/e2e/tool-category-audit.mjs
 *
 * 为什么需要：`category` 决定工具的最低角色门槛（见 开发指南 §2.8）；policy 对**未知类别** fail-closed
 * 按「仅主人可用」处理。手写内置工具（不经 SDK defineTool 的默认 'query' 兜底）一旦漏声明，
 * 普通用户/管理员调用会被静默拒绝——实机事故：memory（长期记忆）工具漏声明 category，
 * 群管理员写记忆被拒「角色 admin 低于 未知 所需等级」，这条记忆压根没进库。
 * 单测覆盖不到 apps 层装配，故这里用真实 runtime 全量审计（默认配置离线可跑）。
 *
 * 断言：
 *   1. 全部工具都有非空 category（含内置 + toolEvo 契约 + 外置工具包）；
 *   2. category 均为已知类别（CATEGORY_MIN 键集；默认配置未加自定义类别）；
 *   3. 定点回归：memory === 'personal' 且 member/admin 可调用（decide=allow）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `e2e-tool-category-${process.pid}-`))
process.env.E2E_TMP = TMP
process.env.E2E_REAL_AGENT = '1'
await import(pathToFileURL(path.join(import.meta.dirname, 'hooks.mjs')).href)

const { __setConfig } = await import('./stubs/Config.js')
__setConfig({
  agent: {
    devLog: { dir: path.join(TMP, 'devlog') },
    apiKey: 'sk-category-audit', // 过掉 buildRuntime 的 apiKey 闸；不发任何真实请求
    model: 'test-model',
    sandbox: { mode: 'off' },
    webApi: { enable: false },
  },
})

let passed = 0
let failed = 0
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }

console.log('\n[真实 buildRuntime · 工具 category 全量审计]')
const { getRuntime } = await import('../../apps/agent.js')
const { decide, CATEGORY_MIN } = await import('../../model/agent/policy.js')

let tools = []
try {
  const rt = await getRuntime()
  tools = rt.tools?.list?.() || []
  ok(tools.length > 50, `已注册工具 ${tools.length} 个（>50 说明装配完整）`)
} catch (e) {
  ok(false, `buildRuntime 装配失败：${e?.message || e}`)
}

const known = new Set(Object.keys(CATEGORY_MIN))
const missing = tools.filter((t) => t.category == null || String(t.category).trim() === '')
const unknown = tools.filter((t) => t.category != null && !known.has(String(t.category)))

ok(missing.length === 0, `全部工具已声明 category${missing.length ? `（缺失：${missing.map((t) => t.name).join(', ')}）` : ''}`)
ok(unknown.length === 0, `全部 category 均为已知类别${unknown.length ? `（未知：${unknown.map((t) => `${t.name}=${t.category}`).join(', ')}）` : ''}`)

// 定点回归：memory（长期记忆）必须 personal 且非主人可用
const mem = tools.find((t) => t.name === 'memory')
ok(!!mem, 'memory 工具已注册')
ok(mem?.category === 'personal', `memory 类别为 personal（实际 ${JSON.stringify(mem?.category)}）`)
if (mem) {
  ok(decide({ role: 'member', isMaster: false }, mem).decision === 'allow', 'member 可写长期记忆')
  ok(decide({ role: 'admin', isMaster: false }, mem).decision === 'allow', 'admin 可写长期记忆')
}

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1

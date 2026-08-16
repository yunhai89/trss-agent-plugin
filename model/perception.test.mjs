/**
 * Perception 离线自检 —— buildSituationalContext（时间/角色/运行能力盘点/近期对话）。
 * 运行：node model/perception.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildSituationalContext, formatHistory, messageToText, MET_PREFIX, ACTIVE_PREFIX } from './perception.js'
import { memoryKv } from './agent/store/kv.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack) } }

// 注意：本测试在 /root/agents-plugin 下运行，需要能 import model/agent/store/kv.js。
// perception.js 本身零依赖（除 kv 注入）。

function mockRuntime({ toolNames = [], mcpStatus = {}, cfg = {} } = {}) {
  // 工具名→类别映射（模拟 ToolRegistry.list() 返回的带 category 工具对象）
  const CAT = { web_search: 'query', miyoushe_search: 'query', group_info: 'query', group_kick: 'system' }
  return {
    agent: {
      tools: {
        names: () => toolNames,
        list: () => toolNames.map((n) => ({ name: n, category: CAT[n] || 'query' })),
      },
    },
    mcp: { status: () => mcpStatus },
  }
}

// ---------- 1. messageToText / formatHistory ----------
await test('formatHistory：拼文本 + 跳过当前 + 正序', async () => {
  const msgs = [
    { message_id: 'cur', sender: { nickname: 'me' }, message: [{ type: 'text', text: '在吗' }] },
    { message_id: '2', sender: { card: '小红' }, message: [{ type: 'text', text: '看图' }, { type: 'image' }] },
    { message_id: '1', sender: { nickname: '甲' }, message: [{ type: 'text', text: '你好' }] },
  ]
  const lines = formatHistory(msgs, { message_id: 'cur' })
  ok(lines.length === 2, '剔除当前后 2 条')
  ok(lines[0].includes('甲: 你好'), '正序首条=甲')
  ok(lines[1].includes('小红: 看图[图片]'), '图片标注')
  ok(messageToText({ message: [{ type: 'record' }, { type: 'text', text: 'x' }] }) === '[语音]x', '语音标注')
})

// ---------- 2. 运行能力盘点：工具 + MCP + 能力 ----------
await test('buildSituationalContext：运行能力盘点（工具/MCP/能力）', async () => {
  const kv = memoryKv()
  const cfg = { media: { enable: true }, vision: { model: 'mimo-2.5' } }
  const rt = mockRuntime({
    toolNames: ['web_search', 'miyoushe_search', 'group_info', 'group_kick', 'delegate__x'],
    mcpStatus: { a: { status: 'connected' }, b: { status: 'error' } },
  })
  const ctx = { userId: 'u1', isGroup: false }
  const out = await buildSituationalContext({ ctx, runtime: rt, e: null, kv, cfg })
  console.log('  输出片段：\n' + out.split('\n').map((l) => '    ' + l).join('\n'))
  ok(out.includes('【当前时间】'), '含时间')
  ok(out.includes('【运行能力盘点】'), '含自我状态')
  ok(out.includes('查询类'), '列工具类别计数（审计 §3.2：不再列全量工具名，改类别+计数）')
  ok(!out.includes('web_search') && !out.includes('miyoushe_search'), '不列具体工具名（防见名无 schema 直调得 not_found）')
  ok(!out.includes('delegate__x'), '排除委派工具')
  ok(out.includes('1 个 MCP 服务端'), 'MCP 连接数=1（a 连接，b 错误）')
  ok(out.includes('视觉识别'), '能力含视觉')
})

// ---------- 3. MCP 0 连接时的关键话术 ----------
await test('MCP 未接入时：运行能力盘点明确"协议可用但未接入"', async () => {
  const kv = memoryKv()
  const rt = mockRuntime({ toolNames: ['web_search'], mcpStatus: {} })
  const out = await buildSituationalContext({ ctx: { userId: 'u', isGroup: false }, runtime: rt, e: null, kv, cfg: {} })
  ok(out.includes('0 个 MCP 服务端'), 'MCP=0')
  ok(out.includes('协议可用但暂未接入'), '关键透明话术')
})

// ---------- 4. 群聊发言者角色 ----------
await test('群聊：注入发言者角色与权限', async () => {
  const kv = memoryKv()
  const rt = mockRuntime({ toolNames: ['web_search'] })
  const out = await buildSituationalContext({ ctx: { userId: 'u', isGroup: true, groupId: 'g', isMaster: true }, runtime: rt, e: null, kv, cfg: {} })
  ok(out.includes('【发言者】主人'), '主人角色')
  ok(out.includes('可执行敏感指令'), '主人权限提示')
})

// ---------- 5. 首次入群：写标记 + 群信息/历史 ----------
await test('首次入群：注入群信息+历史，并写感知标记', async () => {
  const kv = memoryKv()
  const group = {
    getInfo: async () => ({ group_name: '测试群', member_count: 5, max_member_count: 100, owner_id: '1' }),
    getChatHistory: async () => [
      { message_id: 'cur', sender: { nickname: 'x' }, message: [{ type: 'text', text: '@bot' }] },
      { message_id: 'm1', sender: { nickname: '甲' }, message: [{ type: 'text', text: '今天聊啥' }] },
    ],
  }
  const e = { message_id: 'cur', group }
  const ctx = { userId: 'u', isGroup: true, groupId: 'g9' }
  const rt = mockRuntime({ toolNames: [] })
  const out = await buildSituationalContext({ ctx, runtime: rt, e, kv, cfg: {}, bot: null })
  ok(out.includes('入群感知') && out.includes('测试群'), '含群名')
  ok(out.includes('今天聊啥'), '含历史')
  ok(await kv.get(`${MET_PREFIX}g9`), '已写感知标记')
  // 二次：不再注入历史
  const out2 = await buildSituationalContext({ ctx, runtime: rt, e, kv, cfg: {}, bot: null })
  ok(!out2.includes('入群感知'), '二次不再全量感知')
})

// ---------- 6. 久未发言补课 ----------
await test('久未发言（>6h）：补取近期对话', async () => {
  const kv = memoryKv()
  await kv.set(`${MET_PREFIX}g8`, { at: Date.now() }) // 已感知过
  await kv.set(`${ACTIVE_PREFIX}g8`, { at: Date.now() - 7 * 3600 * 1000 }) // 7h 前
  const group = { getChatHistory: async () => [{ message_id: 'm', sender: { nickname: '甲' }, message: [{ type: 'text', text: '刚才聊到哪' }] }] }
  const e = { message_id: 'cur', group }
  const ctx = { userId: 'u', isGroup: true, groupId: 'g8' }
  const out = await buildSituationalContext({ ctx, runtime: mockRuntime(), e, kv, cfg: {}, bot: null })
  ok(out.includes('久未发言补课'), '触发补课')
  ok(out.includes('刚才聊到哪'), '含近期对话')
})

// ---------- 总结 ----------
console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1

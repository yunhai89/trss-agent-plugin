/**
 * 接线回归：`#沙箱诊断` 主人命令（静态自检 / 旧值修复 / 未启用时的降级）+ 出口自检日志。
 *
 * 走真实 apps/agent.js（离线：不建真沙箱；`实测` 分支在 mode=off 时只验证降级路径）。
 * 运行：node --import ./stress/e2e/hooks.mjs stress/e2e/sandbox-diag-command.mjs
 *
 * 注意：Config 桩的 save() 会抛——`#沙箱诊断 修复` 必须优雅降级（内存已清 + 明确告知写盘失败），
 * 这条正是「配置迁移不能把运行时报错带出来」的守门用例。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `e2e-sbx-diag-${process.pid}-`))
process.env.E2E_TMP = TMP
process.env.E2E_REAL_AGENT = '1'
await import(pathToFileURL(path.join(import.meta.dirname, 'hooks.mjs')).href)

const cfgMod = await import('./stubs/Config.js')
const { __setConfig, __state } = cfgMod

let passed = 0
let failed = 0
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}（实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`)

const LEGACY_SANDBOX = {
  mode: 'off', // 实测分支走「未启用 → 降级」，不建真沙箱
  apiKey: 'e2b_test_key',
  template: 'base',
  network: { allowInternet: true, allowOut: [], denyOut: ['0.0.0.0/0'] },
}
__setConfig({ agent: { apiKey: 'sk-wiring-test', model: 'test-model', devLog: { dir: TMP + '/devlog' }, sandbox: LEGACY_SANDBOX } })

const { Chat } = await import('../../apps/agent.js')
const chat = new Chat()
const replies = []
const asMaster = (msg) => { chat.e = { msg, user_id: 10001, isMaster: true, reply: async (t) => { replies.push(String(t)); return true } } }

console.log('\n[命令注册]')
{
  const rules = (chat.rule || []).map((r) => r.reg)
  const rule = (chat.rule || []).find((r) => r.fnc === 'sandboxDiag')
  ok(!!rule, 'rule 表里有 sandboxDiag')
  // 2026-10-29 QQ 官方机器人适配：规则级 master 改为插件内判定
  // （框架 e.isMaster 按 QQ 号匹配，官方 openid 永远不命中 → 主人指令全不可用）。
  // 契约变为：permission='all' + __masterGate 标记 + 入口 isOfficialMaster 复核。
  eq(rule?.permission, 'all', '权限交插件内判定（原 master）')
  eq(rule?.__masterGate, true, '规则带 masterGate 标记（入口复核主人身份）')
  ok(new RegExp(rule.reg).test('#沙箱诊断') && new RegExp(rule.reg).test('#沙箱诊断 预览') && new RegExp(rule.reg).test('#沙箱诊断 修复'), '正则可匹配三种用法')
  ok(!new RegExp(rule.reg).test('#沙箱诊断x'), '不会误匹配 #沙箱诊断x')
  ok(rules.length > 0, '其余规则未受影响')
}

console.log('\n[#沙箱诊断 预览]')
{
  replies.length = 0
  asMaster('#沙箱诊断 预览')
  const handled = await chat.sandboxDiag()
  eq(handled, true, '返回 true（已处理，不再触发 AI 对话）')
  const text = replies.join('\n')
  ok(text.includes('沙箱出口自检（静态）'), '给出静态自检标题')
  ok(text.includes('0.0.0.0/0'), '回显配置里的旧值')
  ok(text.includes('拒绝一切出口'), '点明它会拒绝一切出口')
  ok(text.includes('#沙箱诊断 修复'), '给出迁移入口')
  ok(!text.includes('正在沙箱内实测'), '预览模式不触发实测')
}

console.log('\n[#沙箱诊断 修复（Config 桩 save 抛错 → 必须优雅降级且内存已清）]')
{
  replies.length = 0
  asMaster('#沙箱诊断 修复')
  const handled = await chat.sandboxDiag()
  eq(handled, true, '返回 true')
  const text = replies.join('\n')
  ok(text.includes('写盘失败'), '写盘失败时明确告知（不抛穿）')
  ok(text.includes('本次会话生效'), '说明本次会话已生效')
  eq(__state.config.agent.sandbox.network.denyOut, [], '内存配置里的旧值已被清除')
}

console.log('\n[#沙箱诊断 修复（已无旧值 → 幂等）]')
{
  replies.length = 0
  asMaster('#沙箱诊断 修复')
  await chat.sandboxDiag()
  const text = replies.join('\n')
  ok(text.includes('没有需要迁移的旧值'), '重复执行给出「无需迁移」而不是报错')
}

console.log('\n[#沙箱诊断（实测）在 mode=off 时降级]')
{
  replies.length = 0
  asMaster('#沙箱诊断')
  const handled = await chat.sandboxDiag()
  eq(handled, true, '返回 true')
  const text = replies.join('\n')
  ok(text.includes('正在沙箱内实测'), '先给进度提示')
  ok(text.includes('无法实测') || text.includes('沙箱未启用'), '未启用时说明无法实测，而不是抛错/空等')
}

console.log('\n[用法纠错]')
{
  replies.length = 0
  asMaster('#沙箱诊断 乱写')
  await chat.sandboxDiag()
  ok(replies.join('\n').includes('用法：#沙箱诊断'), '未知子命令给出用法')
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`)
process.exit(failed ? 1 : 0)

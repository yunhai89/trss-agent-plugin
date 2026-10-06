/**
 * 回归（F02）：`#清空所有记录` 必须真正清空该用户的压缩归档，且会话 id 不被复用重新绑定旧归档。
 *
 * 背景：压缩原文归档独立于会话 KV 落盘（按 convKey 分目录），原 clearMyData 只删会话 KV，
 * 归档留存；且清空会重置编号序列，新对话重新拿到 id=1 → 又绑回同一个归档目录，
 * 已"清空"的旧原文可再次被 context_recall 召回（同一用户、清理后重新可见）。
 *
 * 运行：node --import ./stress/e2e/hooks.mjs stress/e2e/compaction-clear.mjs
 * （hooks 把 Yunzai 基类 / utils/Config 换成桩，apps/agent.js 保持真实源码；不联网、不调真实模型）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `e2e-compact-clear-${process.pid}-`))
process.env.E2E_TMP = TMP
process.env.E2E_REAL_AGENT = '1'
await import(pathToFileURL(path.join(import.meta.dirname, 'hooks.mjs')).href)

const cfgMod = await import('./stubs/Config.js')
const archiveDir = path.join(TMP, 'archive')
cfgMod.__setConfig({ agent: {
  apiKey: 'sk-offline-fixture', model: 'offline-fixture',
  compaction: { enable: true, archiveDir },
  devLog: { dir: path.join(TMP, 'devlog') },
  multiagent: { enable: false }, sandbox: { mode: 'off' },
  toolEvo: { enable: false }, sticker: { enable: false },
  tools: { builtin: false }, schedule: { taskEnabled: false },
  webApi: { enable: false }, skill: { dir: path.join(TMP, 'skills') },
} })

let passed = 0
let failed = 0
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }

const { Chat, getRuntime } = await import('../../apps/agent.js')
const rt = await getRuntime()
const arch = rt.agentConfig.compactArchive
ok(!!arch, '压缩归档已装配')

const first = await rt.session.createConversation('1234', null)
const oldMarker = 'DELETED_PRIVATE_MARKER_42'
const saved = arch.save({ convKey: `1234:p:${first.id}`, epoch: 1, messages: [{ role: 'user', content: oldMarker }] })
// 另一个用户 / 群共享域的归档必须在清理本人数据后保留
const otherSaved = arch.save({ convKey: '9999:p:1', epoch: 1, messages: [{ role: 'user', content: 'OTHER_USER_MARKER' }], })

const replies = []
const chat = new Chat({})
chat.e = {
  user_id: '1234', self_id: '2721779039', msg: '#清空所有记录', isGroup: false,
  message: [], sender: { user_id: '1234', nickname: 'fixture' },
  reply: async (text) => { replies.push(String(text)); return { message_id: 'offline' } },
}
await chat.clearMyData()
await chat.clearMyData()
ok(replies.at(-1).includes('已清空你的所有记录'), '清理命令报告成功')
ok(replies.at(-1).includes('压缩归档'), '清理清单明确包含压缩归档')

const fresh = await rt.session.createConversation('1234', null)
ok(fresh.id !== first.id, `清空后新对话不复用旧 id（旧 ${first.id} → 新 ${fresh.id}）`)
ok(!fs.existsSync(path.join(archiveDir, `1234_p_${first.id}`)), '旧压缩归档目录已删除')

const recall = rt.tools.get('context_recall')
const q = await recall.execute({ query: oldMarker }, { userId: '1234', scopeUserId: '1234', groupId: null, conversationId: fresh.id })
const byRef = await recall.execute({ ref: saved.ref }, { userId: '1234', scopeUserId: '1234', groupId: null, conversationId: fresh.id })
ok(!q.ok, '清空后关键词无法召回旧内容')
ok(!byRef.ok, '清空后旧 ref 无法召回旧内容')
ok(fs.existsSync(path.join(archiveDir, '9999_p_1')), '其他用户的归档未被波及')
ok(arch.get(otherSaved.ref, { convKey: '9999:p:1' }).ok, '其他用户归档仍可读取')

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1

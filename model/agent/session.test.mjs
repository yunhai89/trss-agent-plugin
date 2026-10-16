/**
 * SessionStore 群共享「对话 API」迁移兜底与坏值护栏回归用例。
 *
 * 背景（第 8 轮审计 medium-1）：`get()` 里的旧键迁移兜底只覆盖 `group:user` 会话键，而正常聊天
 * 走 conversation API（直接读 kv）→ v1.26.30 把共享作用域从字面量 `__group__` 改成 `__group__:<gid>`
 * 后，旧键 `sess:conv:<gid>:__group__:<cid>` 读不到，共享群里机器人升级后「失忆」（历史被割裂、
 * append 从空对话重建）。
 */
import { SessionStore } from './session.js'

let pass = 0, fail = 0
const ok = (c, m) => { c ? pass++ : (fail++, console.log(`  ✗ ${m}`)) }

function mkKv(init = {}) {
  const map = new Map(Object.entries(init))
  return {
    map,
    async get(k) { return map.has(k) ? map.get(k) : null },
    async set(k, v) { map.set(k, JSON.parse(JSON.stringify(v))) },
    async del(k) { map.delete(k) },
    async scan(prefix) { return [...map.keys()].filter((k) => k.startsWith(prefix)) },
  }
}

const conv = (id, texts) => ({ id, title: `对话 ${id}`, messages: texts.map((t) => ({ role: 'user', content: t })), createdAt: 1, updatedAt: 2 })
const mk = (kv) => new SessionStore({ kv, logger: () => {} })
const NEW = 'Yz:agent:sess:conv:g1:__group__:g1:c1'
const OLD = 'Yz:agent:sess:conv:g1:__group__:c1'

// 1) 新键缺失、旧键存在 → 读到旧对话并迁移到新键
{
  const kv = mkKv({ [OLD]: conv('c1', ['旧历史1', '旧历史2']) })
  const s = mk(kv)
  const c = await s.getConversation('__group__:g1', 'g1', 'c1')
  ok(Array.isArray(c) && c.length === 2 && c[0].content === '旧历史1', '读到旧群共享对话（升级不失忆）')
  ok(kv.map.has(NEW), '顺手迁移到新键（避免每次回退）')
}

// 2) append 命中旧键 → 在旧历史上追加，而不是从空对话重建
{
  const kv = mkKv({ [OLD]: conv('c1', ['旧历史1']) })
  const s = mk(kv)
  await s.appendConversation('__group__:g1', 'g1', 'c1', [{ role: 'user', content: '新消息' }])
  const after = kv.map.get(NEW) || kv.map.get(OLD)
  ok(after.messages.length === 2 && after.messages[1].content === '新消息', 'append 接在旧历史之后（历史不割裂）')
}

// 3) listConversations 合并旧键（共享作用域）
{
  const kv = mkKv({ [OLD]: conv('c1', ['旧历史1']), 'Yz:agent:sess:conv:g1:__group__:g1:c2': conv('c2', ['新对话']) })
  const s = mk(kv)
  const list = await s.listConversations('__group__:g1', 'g1')
  const ids = list.map((x) => x.id).sort()
  ok(ids.length === 2 && ids[0] === 'c1' && ids[1] === 'c2', `旧+新对话都列出（${ids.join(',')}）`)
  // 旧键的 seq 键不应被当成对话
  const kv2 = mkKv({ 'Yz:agent:sess:conv:g1:__group__:c1:seq': 3 })
  const s2 = mk(kv2)
  const list2 = await s2.listConversations('__group__:g1', 'g1')
  ok(!list2.some((x) => String(x.id).includes(':seq')), 'seq 键不被当成对话')
}

// 4) 坏值护栏：字符串值拒绝写入且不覆盖
{
  const kv = mkKv({ [NEW]: 'not-a-conversation' })
  const s = mk(kv)
  let threw = null
  try { await s.appendConversation('__group__:g1', 'g1', 'c1', [{ role: 'user', content: 'x' }]) } catch (e) { threw = e?.message || String(e) }
  ok(!!threw && /损坏/.test(threw), '字符串坏值 → 抛「会话数据损坏」而不是静默写坏')
  ok(kv.map.get(NEW) === 'not-a-conversation', '坏值原文未被覆盖（用户仍可自行清理/导出）')
}

// 5) 个人作用域不回退旧群键（避免跨群串话）
{
  const kv = mkKv({ [OLD]: conv('c1', ['旧群历史']) })
  const s = mk(kv)
  const c = await s.getConversation('u123', 'g1', 'c1')
  ok(Array.isArray(c) && c.length === 0, '个人作用域不会读到 __group__ 的旧键（返回空历史）')
}

console.log(`\nsession 迁移/护栏测试：通过 ${pass}，失败 ${fail}`)
process.exit(fail ? 1 : 0)

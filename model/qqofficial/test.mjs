/**
 * QQ 官方机器人适配层离线自检。
 *
 * 覆盖：
 *  ① 适配器识别（QQBot / QQGuild / OneBot / ID 形态兜底）；
 *  ② 上下文类型（群聊 / C2C / 频道 / 频道私聊）与 ID 去前缀（含 Windows 无分隔符情况）；
 *  ③ scope 目录安全化（数字 ID 保持原样=旧目录兼容；含非法字符净化 + 短哈希防撞）；
 *  ④ markdown/button 段构造与能力探测、按钮裁剪/默认权限、@ 合并；
 *  ⑤ markdown→纯文本降级与按行分片（代码块围栏闭合）；
 *  ⑥ send_keyboard 工具：入参校验、非官方协议拒绝、排队与投递；
 *  ⑦ /uid、/groupid 诊断信息（describeContext）。
 *
 * 运行：node model/qqofficial/test.mjs
 */
import {
  detectAdapter, contextKind, contextLabel, stripSelfPrefix, rawUserId, rawGroupId, splitGuildId,
  safeScopePart, deriveScope, markdownSegment, hasMarkdownSegment, hasButtonSegment,
  normalizeKeyboard, keyboardSegments, buildMarkdownMessage, markdownToPlain, splitMarkdown,
  describeContext, MARKDOWN_MAX_CHARS, KEYBOARD_MAX_ROWS, KEYBOARD_MAX_PER_ROW,
} from './index.js'
import { makeSendKeyboardTool, normalizeCardSpec, flushPendingCards, MAX_CARDS_PER_RUN } from './tool.js'
import Config from '../../utils/Config.js'

let passed = 0
let failed = 0
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}${JSON.stringify(a) === JSON.stringify(b) ? '' : `（实际 ${JSON.stringify(a)}）`}`)

// ── 0. 无 segment 的框架：所有能力探测应为 false，不抛错 ──────────────────
console.log('\n[0] 无 segment 环境（Miao 等）')
eq(hasMarkdownSegment(), false, '无全局 segment → hasMarkdownSegment=false')
eq(hasButtonSegment(), false, '无全局 segment → hasButtonSegment=false')
eq(markdownSegment('# hi'), null, '无 segment → markdownSegment 返回 null')
eq(buildMarkdownMessage({ user_id: '1' }, '# hi'), null, '无 segment → buildMarkdownMessage 返回 null')

// ── 模拟 TRSS-Yunzai 的全局 segment（markdown/button/at） ─────────────────
const calls = []
globalThis.segment = {
  markdown(data) { calls.push(['markdown', data]); return { type: 'markdown', data } },
  button(...data) { calls.push(['button', data]); return { type: 'button', data } },
  at(qq) { return { type: 'at', qq } },
}
console.log('\n[1] 适配器识别')
{
  const self = '1024'
  const eQQBot = { self_id: self, adapter_id: 'QQBot', adapter_name: 'QQBot', isGroup: true, group_id: `${self}:G_OPENID`, user_id: `${self}:U_OPENID` }
  const r1 = detectAdapter(eQQBot)
  ok(r1.official && r1.kind === 'qqbot', 'adapter_id=QQBot → qqbot/official')
  const eGuild = { self_id: self, adapter_id: 'QQGuild', adapter_name: 'QQ频道', isGroup: true, group_id: 'qg_123-456', user_id: 'qg_abc' }
  const r2 = detectAdapter(eGuild)
  ok(r2.official && r2.kind === 'guild', 'adapter_id=QQGuild → guild/official')
  const r3 = detectAdapter({ self_id: self, adapter_id: 'OneBotv11', adapter_name: 'NapCat', isGroup: true, group_id: '123456', user_id: '10086' })
  ok(!r3.official && r3.kind === 'other', 'OneBotv11 数字 ID → other（不误判）')
  const r4 = detectAdapter({ self_id: self, isGroup: true, group_id: `${self}:G`, user_id: `${self}:U` })
  ok(r4.official && r4.kind === 'qqbot' && r4.reason === 'id-shape', '无 adapter 字段时按带前缀 ID 形态兜底')
  const r5 = detectAdapter({ self_id: self, isGroup: false, user_id: 'qg_openid' })
  ok(r5.official && r5.kind === 'guild' && r5.reason === 'id-shape', 'qg_ 前缀兜底为频道')
  eq(detectAdapter(null).official, false, '空事件不误判为官方')
}

console.log('\n[2] 上下文与 ID 去前缀')
{
  const self = '1024'
  const grp = { self_id: self, isGroup: true, group_id: `${self}:G_OPENID`, user_id: `${self}:U_OPENID`, adapter_id: 'QQBot' }
  const c2c = { self_id: self, isGroup: false, user_id: `${self}:U_OPENID`, adapter_id: 'QQBot' }
  const guild = { self_id: self, isGroup: true, group_id: 'qg_98765-43210', user_id: 'qg_abc', adapter_id: 'QQGuild' }
  const gdm = { self_id: self, isGroup: false, user_id: 'qg_abc', adapter_id: 'QQGuild' }
  eq(contextKind(grp), 'group', '群聊上下文')
  eq(contextKind(c2c), 'c2c', 'C2C 私聊上下文')
  eq(contextKind(guild), 'guild', '频道上下文')
  eq(contextKind(gdm), 'guild_dm', '频道私聊上下文')
  eq(contextLabel(grp), '群聊', '上下文中文名')
  eq(rawUserId(grp), 'U_OPENID', '群聊 user_id 去 self 前缀')
  eq(rawGroupId(grp), 'G_OPENID', '群聊 group_id 去 self 前缀')
  eq(rawUserId({ self_id: self, user_id: 'U_OPENID', adapter_id: 'QQBot' }), 'U_OPENID', 'Windows（无前缀）原样返回')
  eq(rawUserId({ self_id: '1024', user_id: '10245', adapter_id: 'QQBot' }), '10245', '前缀只按 self_id+分隔符剥，不误切数字')
  eq(splitGuildId(guild), { guildId: '98765', channelId: '43210' }, '频道 ID 拆 guild/channel')
  eq(splitGuildId(grp), null, '非频道不拆')
  eq(stripSelfPrefix('qg_x', grp), 'x', 'qg_ 前缀剥离')
}

console.log('\n[3] scope 目录安全化（旧目录兼容 + 官方 ID 净化）')
{
  eq(safeScopePart('123456'), '123456', '数字 ID 原样（旧目录兼容）')
  eq(safeScopePart('u_123'), 'u_123', '下划线原样')
  const a = safeScopePart('1024:U_OPENID')
  ok(/^[A-Za-z0-9_-]+$/.test(a), `含冒号 ID 净化后目录安全（${a}）`)
  ok(a.startsWith('1024-U_OPENID-'), '净化形式可读（原值 + 短哈希）')
  ok(safeScopePart('1024:U') !== safeScopePart('1024_U'), '不同原值净化后不撞车')
  eq(safeScopePart('1024:U'), safeScopePart('1024:U'), '同值稳定')

  // 数字 ID：与旧实现完全一致的 scopeId/scopeUserId（不迁移历史数据）
  const legacy = deriveScope({ self_id: '1', isGroup: true, group_id: '88888', user_id: '10086' }, true)
  eq({ scopeId: legacy.scopeId, scopeUserId: legacy.scopeUserId }, { scopeId: 'g88888_u10086', scopeUserId: '10086' }, '数字 ID scope 与旧实现一致')
  const shared = deriveScope({ self_id: '1', isGroup: true, group_id: '88888', user_id: '10086' }, false)
  eq(shared.scopeId, 'g88888', 'isolation=false → 群共享 scope')
  const priv = deriveScope({ self_id: '1', isGroup: false, user_id: '10086' }, true)
  eq(priv.scopeId, 'u_10086', '私聊 scope')

  const off = deriveScope({ self_id: '1024', isGroup: true, group_id: '1024:G', user_id: '1024:U', adapter_id: 'QQBot' }, true)
  ok(/^g[A-Za-z0-9_-]+_u[A-Za-z0-9_-]+$/.test(off.scopeId), `官方 ID scope 目录安全（${off.scopeId}）`)
  ok(off.official && off.contextKind === 'group', 'deriveScope 同时给出 official/contextKind')
}

console.log('\n[4] markdown / keyboard 段构造')
{
  calls.length = 0
  const md = markdownSegment('# 标题\n正文')
  eq(md, { type: 'markdown', data: '# 标题\n正文' }, 'markdownSegment 产出 TRSS markdown 段')
  const tpl = markdownSegment({ templateId: 'tpl-1', params: [{ key: 'k', values: ['v'] }] })
  eq(tpl, { type: 'markdown', data: { custom_template_id: 'tpl-1', params: [{ key: 'k', values: ['v'] }] } }, '模板 ID 模式产出 custom_template_id 载荷')

  const rows = normalizeKeyboard([
    [{ text: '确认', callback: '#确认 1' }, { text: '打开', link: 'https://example.com' }],
    [{ text: '输入', input: 'hello', send: false, clicked_text: '点了' }],
    [{ text: '   ' }, 'bad', { text: '无动作' }],
  ])
  eq(rows.length, 2, '空/无动作按钮被丢弃，行数保留')
  eq(rows[0].length, 2, '第一行两个有效按钮')
  eq(rows[1][0].clicked_text, '点了', 'clicked_text 透传')
  const clampRows = normalizeKeyboard(Array.from({ length: KEYBOARD_MAX_ROWS + 3 }, (_, i) => [{ text: `b${i}`, callback: `c${i}` }]))
  eq(clampRows.length, KEYBOARD_MAX_ROWS, `行数裁剪到 ${KEYBOARD_MAX_ROWS}`)
  const clampCols = normalizeKeyboard([Array.from({ length: KEYBOARD_MAX_PER_ROW + 2 }, (_, i) => ({ text: `b${i}`, callback: `c${i}` }))])
  eq(clampCols[0].length, KEYBOARD_MAX_PER_ROW, `每行裁剪到 ${KEYBOARD_MAX_PER_ROW} 个`)

  const kb = keyboardSegments([[{ text: '确认', callback: '#确认 1' }, { text: '打开', link: 'https://x' }]], { ownerId: '1024:U_OPENID' })
  ok(kb.length === 1 && kb[0].type === 'button', '每行一个 button 段')
  // segment.button(row) → { type:'button', data:[row] }；适配器 `for (const button_row of i.data)` 逐行取。
  const btnRow = kb[0].data[0]
  ok(Array.isArray(btnRow) && btnRow.length === 2, 'button 段 data[0] 为该行按钮数组（适配器契约）')
  eq(btnRow[0].permission, ['1024:U_OPENID'], '回调按钮默认仅触发者（不公开）')
  ok(!btnRow[1].permission, '链接按钮不加用户限制')

  const kbPublic = keyboardSegments([[{ text: '公开', callback: 'x', public: true }]], { ownerId: 'u1', allowPublic: true })
  ok(!kbPublic[0].data[0][0].permission, 'allowPublic 时 public 按钮不限人')

  const msg = buildMarkdownMessage({ user_id: '1024:U' }, '# hi', { atSender: { type: 'at', qq: '1024:U' }, keyboard: [[{ text: 'k', callback: 'c' }]] })
  ok(Array.isArray(msg) && msg.length === 3, '@ + markdown + 按钮 三段合并为数组')
  eq(msg[0].type, 'at', '第一段是 @')
  eq(msg[1].type, 'markdown', '第二段是 markdown')
  eq(msg[2].type, 'button', '第三段是按钮')
  const single = buildMarkdownMessage({ user_id: 'u' }, '# hi')
  ok(single && !Array.isArray(single) && single.type === 'markdown', '无 @ / 无按钮时返回单段')
}

console.log('\n[5] markdown→纯文本 与 分片')
{
  const md = '# 标题\n**粗体** 与 `code`\n- 列表一\n- 列表二\n[链接](https://a.b)\n```js\nconst a = 1\n```'
  const plain = markdownToPlain(md)
  ok(!plain.includes('#') && !plain.includes('**') && !plain.includes('`'), `剥掉 md 标记（${JSON.stringify(plain.slice(0, 40))}…）`)
  ok(plain.includes('链接（https://a.b）'), '链接保留地址')
  ok(plain.includes('const a = 1'), '代码块内容保留')

  const long = Array.from({ length: 200 }, (_, i) => `第${i}行：这是一段用于分片测试的较长文本内容，包含标点与数字 1234567890。`).join('\n')
  const chunks = splitMarkdown(long, 800)
  ok(chunks.length > 1, `长文本被分片（${chunks.length} 片）`)
  ok(chunks.every((c) => c.length <= 800), '每片不超过上限')
  eq(chunks.join('\n').replace(/\n+/g, '\n'), long.replace(/\n+/g, '\n'), '分片拼回内容不丢行')

  const fence = '```js\n' + Array.from({ length: 80 }, (_, i) => `line${i} // ${'x'.repeat(40)}`).join('\n') + '\n```'
  const fchunks = splitMarkdown(fence, 500)
  ok(fchunks.length > 1, '代码块超长会分片')
  ok(fchunks.every((c) => (c.match(/```/g) || []).length % 2 === 0), '每片代码围栏成对闭合（不会渲染错乱）')
  eq(splitMarkdown('', 100), [], '空内容返回空数组')
  eq(splitMarkdown('short', 100), ['short'], '短内容单段')
  ok(MARKDOWN_MAX_CHARS >= 200, '上限常量合理')
}

console.log('\n[6] send_keyboard 工具')
{
  const eQQBot = { self_id: '1024', adapter_id: 'QQBot', isGroup: true, group_id: '1024:G', user_id: '1024:U' }
  const eOneBot = { self_id: '1', adapter_id: 'OneBotv11', isGroup: true, group_id: '123', user_id: '456' }

  eq(normalizeCardSpec({}).error != null, true, '缺 text/keyboard → error')
  eq(normalizeCardSpec({ text: 'hi', keyboard: [] }).error != null, true, '空键盘 → error（不发送无按钮卡片）')
  const good = normalizeCardSpec({ text: '# 选一个', keyboard: [[{ text: 'A', callback: '#ai A' }]] })
  ok(!good.error && good.card.keyboard.length === 1, '合法入参归一成功')
  const tplCard = normalizeCardSpec({ text: '', templateId: 'tpl', keyboard: [[{ text: 'A', callback: 'a' }]] })
  ok(!tplCard.error && tplCard.card.markdown.templateId === 'tpl', '模板模式允许空 text')

  const tool = makeSendKeyboardTool()
  const onebot = await tool.execute({ text: 'hi', keyboard: [[{ text: 'A', callback: 'a' }]] }, { e: eOneBot })
  ok(onebot.error === 'unsupported_protocol', '非官方协议 → unsupported_protocol（不静默成功）')
  const noCtx = await tool.execute({ text: 'hi', keyboard: [[{ text: 'A', callback: 'a' }]] }, {})
  ok(noCtx.error != null, '无事件对象 → error')

  const ctx = { e: eQQBot }
  const r1 = await tool.execute({ text: '# 选', keyboard: [[{ text: 'A', callback: '#ai A' }]] }, ctx)
  ok(r1.ok && r1.queued === 1 && Array.isArray(ctx.pendingCards) && ctx.pendingCards.length === 1, '官方协议 → 卡片入队')
  for (let i = 0; i < MAX_CARDS_PER_RUN; i++) await tool.execute({ text: `# ${i}`, keyboard: [[{ text: 'A', callback: 'a' }]] }, ctx)
  ok(ctx.pendingCards.length === MAX_CARDS_PER_RUN, `单轮卡片上限 ${MAX_CARDS_PER_RUN}（不无限排队）`)

  const sent = []
  const send = async (msg, quote) => { sent.push({ msg, quote }); return { ok: true } }
  const flushed = await flushPendingCards({ ctx, send })
  eq(flushed, { sent: MAX_CARDS_PER_RUN, failed: 0 }, 'flush 投递全部排队卡片')
  ok(ctx.pendingCards.length === 0, 'flush 后清空队列')
  const firstMsg = sent[0].msg
  ok(Array.isArray(firstMsg) && firstMsg[0].type === 'markdown' && firstMsg.some((s) => s.type === 'button'), '投递内容是 markdown+按钮段')
  const btnSeg = firstMsg.find((s) => s.type === 'button')
  eq(btnSeg.data[0][0].permission, ['U'], '卡片回调按钮权限用平台原始 openid（剥 self_id 前缀）')

  const ctx2 = { e: eQQBot, pendingCards: [good.card] }
  const flushedOneBot = await flushPendingCards({ ctx: ctx2, send: async () => ({ ok: true }) })
  const ctx3 = { e: eOneBot, pendingCards: [{ markdown: 'x', keyboard: [[{ text: 'a', callback: 'b' }]] }] }
  const dropped = await flushPendingCards({ ctx: ctx3, send: async () => ({ ok: true }) })
  eq(dropped, { sent: 0, failed: 1 }, '非官方协议 flush 时丢弃（不误发）')
}

console.log('\n[7] /uid、/groupid 诊断信息')
{
  const e = { self_id: '1024', adapter_id: 'QQBot', adapter_name: 'QQBot', isGroup: true, group_id: '1024:G_OPENID', user_id: '1024:U_OPENID', message_id: 'm1' }
  const info = describeContext(e)
  eq(info.adapterKind, 'qqbot', '诊断：适配器类型')
  eq(info.official, true, '诊断：官方协议')
  eq(info.contextLabel, '群聊', '诊断：上下文中文名')
  eq(info.fullUserId, '1024:U_OPENID', '诊断：完整 user_id（配 masters 用）')
  eq(info.rawUserId, 'U_OPENID', '诊断：去前缀 user_id')
  eq(info.fullGroupId, '1024:G_OPENID', '诊断：完整 group_id（配 groups 用）')
  eq(info.rawGroupId, 'G_OPENID', '诊断：去前缀 group_id')
  ok(/^g[A-Za-z0-9_-]+_u[A-Za-z0-9_-]+$/.test(info.scopeId), '诊断：scopeId 目录安全')

  const guildInfo = describeContext({ self_id: '1024', adapter_id: 'QQGuild', isGroup: true, group_id: 'qg_g1-c1', user_id: 'qg_u1' })
  eq(guildInfo.guildId, 'g1', '诊断：频道 guild_id 拆出')
  eq(guildInfo.channelId, 'c1', '诊断：频道 channel_id 拆出')

  const onebot = describeContext({ self_id: '1', adapter_id: 'OneBotv11', isGroup: true, group_id: '123', user_id: '456' })
  eq(onebot.official, false, '诊断：OneBot 标注非官方')
  eq(onebot.scopeId, 'g123_u456', '诊断：OneBot scope 与旧实现一致')
}

console.log('\n========================================')
console.log(`通过 ${passed}，失败 ${failed}`)
console.log('========================================')
if (failed > 0) process.exitCode = 1

// ── 8. 规则级 master 权限兜底（官方 openid 场景）──────────────────────────
console.log('\n[8] 规则级 master 权限兜底')
const { isOfficialMaster, installMasterGate, MASTER_DENIED_TEXT } = await import('./guard.js')
{
  const self = '1024'
  const eQQ = { self_id: self, adapter_id: 'QQBot', isGroup: true, group_id: `${self}:G`, user_id: `${self}:U_MASTER` }
  const eQQOther = { self_id: self, adapter_id: 'QQBot', isGroup: true, group_id: `${self}:G`, user_id: `${self}:U_OTHER` }
  const eOneBot = { self_id: '1', adapter_id: 'OneBotv11', isGroup: true, group_id: '123', user_id: '456' }

  // 构造一个最小插件类：prototype 方法 + 类级 rule 数组（与 Yunzai 一致）
  async function makePlugin() {
    class Fake {
      constructor() {
        this.e = null
        this.replyCalls = []
        this.rule = Fake.rules
      }
      async masterCmd() { this.hit = true; return 'done' }
    }
    Fake.rules = [
      { reg: /^#master$/, fnc: 'masterCmd', permission: 'master' },
      { reg: /^#all$/, fnc: 'allCmd' },
    ]
    return Fake
  }

  const Fake = await makePlugin()
  const inst = new Fake()
  installMasterGate(inst)
  const gated = inst.rule[0]
  eq(gated.permission, 'all', '规则 permission 改为 all（交插件内判定）')
  ok(gated.__masterGate === true, '规则打上 masterGate 标记（幂等）')
  eq(inst.rule[1].permission, undefined, '非 master 规则不受影响')

  // 官方 + masters 命中完整 ID → 放行
  const cfg = { agent: { masters: [`${self}:U_MASTER`] } }
  eq(isOfficialMaster(eQQ, cfg), true, '官方 ID 命中 agent.masters（完整形态）→ 主人')
  eq(isOfficialMaster(eQQOther, cfg), false, '官方 ID 未命中 → 非主人')
  eq(isOfficialMaster({ self_id: self, adapter_id: 'QQBot', user_id: `${self}:U_MASTER` }, { agent: { masters: ['U_MASTER'] } }), true, '去前缀 openid 写法也命中')
  eq(isOfficialMaster(eOneBot, { agent: { masters: ['456'] } }), false, 'OneBot 不经 masters 兜底（保持框架语义）')

  // 入口包装：非主人被拒（带排障提示），主人放行
  const proto = Object.getPrototypeOf(inst)
  const origSelf = Config.get
  Config.get = () => ({ agent: { masters: [`${self}:U_MASTER`] } })
  try {
    const user = { ...eQQOther, reply: async (t) => { user.replied = t } }
    const master = { ...eQQ, reply: async () => {} }
    const r1 = await proto.masterCmd.call({ e: user }, user)
    ok(user.replied === MASTER_DENIED_TEXT, '非主人：拒绝并给出可操作提示（/uid + agent.masters）')
    const r2 = await proto.masterCmd.call({ e: master, hit: false }, master)
    ok(r2 === 'done', '主人：正常执行原方法')
  } finally { Config.get = origSelf }
}

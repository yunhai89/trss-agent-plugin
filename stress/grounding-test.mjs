import { resolveGrounding, formatGroundingBlock, whitelistViolations, windowNames } from '../model/humanize/grounding.js'
let p = 0, f = 0
const ok = (c, m) => { c ? (p++, console.log(' ✓', m)) : (f++, console.error(' ✗', m)) }
const mk = (id, uid, name, text, extra = {}) => ({ id, userId: uid, displayName: name, timestamp: Date.now(), text, segments: [{ type: 'text', text }], replyToId: null, atBot: false, mentionsBotName: false, quotesBot: false, isSelf: false, ...extra })
// 案例还原：芜湖请求禁言，林墨引用芜湖怼芜湖
const win = [
  mk('mW', 'uW', '芜湖', '帮我把我禁言'),
  mk('mL', 'uL', '林墨', '芜湖你搁这儿测试bot呢 权限摆脸上自己不会看', { replyToId: 'mW' }),
]
let g = resolveGrounding(win, { knownBots: new Set() })
ok(g.semanticTarget === '芜湖', `语义所指=芜湖（实际 ${g.semanticTarget}）`)
ok(g.allowedEntities.includes('林墨') && g.allowedEntities.includes('芜湖'), '白名单=林墨+芜湖')
const blk = formatGroundingBlock(g)
ok(blk.includes('被回复的是：芜湖') && blk.includes('帮我把我禁言'), '归属块含被回复者+原话')
// 云海在窗口（旧对话）→ 白名单外，回复提云海 = 违规
const win2 = [mk('mY', 'uY', '云海', '（两小时前的闲聊）'), ...win]  // 云海在窗口但不是最新
g = resolveGrounding(win2, { knownBots: new Set() })
const vio = whitelistViolations('云海这权限摆你脸上', g, windowNames(win2))
ok(vio.includes('云海'), `旧人物越界被查出（${vio}）`)
ok(whitelistViolations('芜湖就芜湖呗', g, windowNames(win2)).length === 0, '白名单内人物放行')
// 纠错：林墨引用 bot 说"我说的是芜湖"
const win3 = [mk('mW', 'uW', '芜湖', '帮我把我禁言'), mk('b1', 'bot', '我', '（bot 认错人的回复）', { isSelf: true }), mk('mL2', 'uL', '林墨', '我说的是芜湖 你指桑骂槐给谁看呢', { replyToId: 'b1', quotesBot: true })]
g = resolveGrounding(win3, { knownBots: new Set() })
ok(g.correction && g.correction.correctTarget === '芜湖', '纠错事件识别（我说的是芜湖）')
ok(formatGroundingBlock(g).includes('禁止反击'), '纠错约束注入')
// bot↔bot 闭环：林墨是已知 bot
const kb = new Set(['uL'])
const duel = [mk('b1', 'bot', '我', '', { isSelf: true }), mk('L1', 'uL', '林墨', 'x', { quotesBot: true }), mk('b2', 'bot', '我', '', { isSelf: true }), mk('L2', 'uL', '林墨', 'y', { quotesBot: true })]
g = resolveGrounding(duel, { knownBots: kb })
ok(g.botChain >= 3, `bot↔bot 链深 ${g.botChain} ≥3`)
const withHuman = [...duel.slice(0, 2), mk('H1', 'uH', '路人', '插一句'), duel[2]]
ok(resolveGrounding(withHuman, { knownBots: kb }).botChain < 3, '真人靠近尾部 → 链不足熔断')
console.log(`通过 ${p} 失败 ${f}`); process.exit(f ? 1 : 0)

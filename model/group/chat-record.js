/**
 * 合并聊天记录（转发卡片）解析与分析。
 *
 * 场景：用户转发进来的「聊天记录」卡片（可能来自别的群/别的人），要分析其内容。
 * 数据源：NapCat `get_forward_msg`（入参 message_id 或 id/resid）。
 *   官方源码：packages/napcat-onebot/action/go-cqhttp/GetForwardMsg.ts
 *   返回 messages = 节点数组，每个节点是 `{ type:'node', data:{ user_id, nickname, message:[消息段], content:[] } }`；
 *   嵌套转发（记录里再套记录）由 NapCat 递归解析进 `data.message` 里的 node 段。
 *   ⚠️ 旧实现按 `n.content`/`n.sender` 读，与 NapCat 实际形状不符 → 取不到内容，这里统一归一。
 *
 * 纯函数（segToText / nodeParts / flattenForwardNodes / analyzeMessages / formatTranscript）便于离线测试。
 */
import { extractForwardResid } from '../media/collect.js'

/** 消息段 → 可读文本（保留类型占位，不丢信息） */
export function segToText(seg) {
  if (typeof seg === 'string') return seg
  if (!seg || typeof seg !== 'object') return ''
  const d = seg.data && typeof seg.data === 'object' ? seg.data : seg
  switch (seg.type) {
    case 'text': return d.text || ''
    case 'at': return `@${d.qq ?? d.user_id ?? ''}`
    case 'image': return '[图片]'
    case 'face': return '[表情]'
    case 'record': case 'voice': return '[语音]'
    case 'video': return '[视频]'
    case 'file': return `[文件:${d.name || d.file || ''}]`
    case 'forward': case 'xml': case 'json': case 'node': return '[嵌套聊天记录]'
    case 'reply': return '[回复]'
    default: return d.text || d.summary || (seg.type ? `[${seg.type}]` : '')
  }
}

/** 归一节点（兼容 NapCat {type:'node',data} 与扁平 {user_id,nickname,message/content}） */
export function nodeParts(n) {
  const d = n && n.type === 'node' && n.data && typeof n.data === 'object' ? n.data : (n || {})
  const uid = d.user_id ?? d.uin ?? d.sender?.user_id
  const nick = d.nickname ?? d.name ?? d.sender?.nickname ?? d.sender?.card
  const segsRaw = d.message ?? d.content ?? d.messages ?? []
  const segs = Array.isArray(segsRaw) ? segsRaw : (segsRaw ? [segsRaw] : [])
  return { uid: uid != null ? String(uid) : '', nick: String(nick || ''), time: d.time, segs }
}

const isNestedSeg = (s) => s && typeof s === 'object' && (s.type === 'node' || s.type === 'forward')

/** 递归展开节点数组 → 扁平消息 [{uid,nick,time,text}]（嵌套记录递归进内容，带深度上限防环）。
 *  兼容两种嵌套形状：node 段的 `data.message` 既可能是「节点数组」(NapCat parseForward)，
 *  也可能是「消息段数组」(部分版本)——对 node 段整体按节点递归即可同时覆盖两者。 */
export function flattenForwardNodes(nodes, { maxDepth = 6 } = {}) {
  const out = []
  const walk = (list, depth) => {
    for (const n of [].concat(list || [])) {
      if (!n || typeof n !== 'object') continue
      const { uid, nick, time, segs } = nodeParts(n)
      const plain = []
      const nested = []
      for (const s of segs) (isNestedSeg(s) ? nested : plain).push(s)
      const text = plain.map(segToText).join('').trim()
      if (text || !nested.length) out.push({ uid, nick, time, text })
      if (nested.length && depth < maxDepth) {
        for (const s of nested) {
          if (s.type === 'node') walk([s], depth + 1) // 嵌套 node：作为节点递归（其 message 是段或节点）
          else { const inner = s?.data?.content ?? s?.content ?? []; walk(inner, depth + 1) } // forward 段：content 是节点数组
        }
      }
    }
  }
  walk(nodes, 0)
  return out
}

/** 时间戳（秒）→ HH:MM（本地时区；缺失返回 ''） */
export function hhmm(ts) {
  const n = Number(ts)
  if (!Number.isFinite(n) || n <= 0) return ''
  const d = new Date(n * 1000)
  const p = (x) => String(x).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 扁平消息 → 「[HH:MM] 昵称: 文本」转录（受 maxChars 截断，保留头尾） */
export function formatTranscript(messages, { maxChars = 12000 } = {}) {
  const lines = (messages || []).map((m) => {
    const t = hhmm(m.time)
    const who = m.nick || m.uid || '?'
    return `${t ? `[${t}] ` : ''}${who}: ${m.text || ''}`
  })
  let text = lines.join('\n')
  if (text.length <= maxChars) return { text, truncated: false, total: lines.length }
  const head = text.slice(0, Math.floor(maxChars * 0.6))
  const tail = text.slice(-Math.floor(maxChars * 0.3))
  return { text: `${head}\n…（中间省略 ${text.length - head.length - tail.length} 字）…\n${tail}`, truncated: true, total: lines.length }
}

/** 确定性统计：条数/时间跨度/发言排行/类型分布/链接/词频 */
export function analyzeMessages(messages) {
  const list = messages || []
  const senders = new Map()
  const times = []
  let links = 0
  const kw = new Map()
  const STOP = new Set(['的', '了', '是', '在', '我', '你', '他', '她', '它', '们', '这', '那', '有', '和', '就', '不', '也', '都', '还', '要', '会', '吗', '吧', '呢', '啊', '嗯', '哈哈', '一个', '什么', '怎么', '可以', '没有', '这个', '那个'])
  for (const m of list) {
    const key = m.nick || m.uid || '?'
    senders.set(key, (senders.get(key) || 0) + 1)
    if (Number.isFinite(Number(m.time)) && m.time > 0) times.push(Number(m.time))
    const text = String(m.text || '')
    links += (text.match(/https?:\/\/[^\s]+/g) || []).length
    // 词频：CJK 连续段 + 英文词
    for (const w of text.match(/[\u4e00-\u9fa5]{2,4}|[A-Za-z][A-Za-z0-9_-]{2,}/g) || []) {
      if (STOP.has(w)) continue
      kw.set(w, (kw.get(w) || 0) + 1)
    }
  }
  const top = (mp, n) => [...mp.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
  const span = times.length ? { from: Math.min(...times), to: Math.max(...times) } : null
  return {
    total: list.length,
    span,
    spanText: span ? `${new Date(span.from * 1000).toLocaleString('zh-CN')} ~ ${new Date(span.to * 1000).toLocaleString('zh-CN')}` : null,
    senders: top(senders, 10).map(([name, count]) => ({ name, count })),
    keywords: top(kw, 12).map(([word, count]) => ({ word, count })),
    links,
  }
}

/** 取合并转发内容（原始节点数组）。sendApiFn(ctx, action, params) → {ok,data} */
export async function fetchForwardNodes(sendApiFn, ctx, id) {
  const r = await sendApiFn(ctx, 'get_forward_msg', { message_id: String(id) })
  if (!r || !r.ok) return { error: r?.error || 'get_forward_msg 调用失败' }
  const data = r.data || {}
  const nodes = Array.isArray(data) ? data : (data.messages || data.message || [])
  return { nodes: Array.isArray(nodes) ? nodes : (nodes ? [nodes] : []) }
}

/** 从当前消息 / 引用消息 里找转发卡片 id（resid 或 message_id） */
export function resolveForwardId(ctx, params = {}) {
  if (params.messageId) return String(params.messageId)
  if (params.resid) return String(params.resid)
  if (params.id) return String(params.id)
  const segs = Array.isArray(ctx?.e?.message) ? ctx.e.message : []
  for (const s of segs) { const r = extractForwardResid(s); if (r) return String(r) }
  if (ctx?.quoted?.forwardResid) return String(ctx.quoted.forwardResid)
  return null
}

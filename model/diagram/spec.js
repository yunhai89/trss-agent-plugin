/**
 * DiagramSpec —— 严格校验与规范化。
 *
 * LLM 只允许提交语义结构（节点/连线/分组/时序消息），本层是安全边界第一站：
 *   - 结构校验（zod，仓库既有依赖）+ 语义校验（引用完整性/环/数量上限，手写）；
 *   - 文本消毒：剔除控制字符、拒绝 HTML/script 标签、外部 URL、data:/javascript: 协议；
 *   - id 规则：拒绝路径分隔符、引号等 DSL 逃逸字符（转义层是第二道保险，这里先拦）；
 *   - canonicalize：字段裁剪 + 对象 key 排序 + 数组保持声明顺序 → 稳定 JSON + specHash。
 *
 * 校验失败统一返回结构化错误（不抛裸异常给模型）：
 *   { ok:false, errorClass:'invalid_arguments', message, field?, retryable:false }
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { THEME_NAMES, DEFAULT_THEME } from './themes.js'

export const DIAGRAM_TYPES = ['flowchart', 'architecture', 'sequence', 'state', 'class', 'er', 'mindmap']
export const NODE_KINDS = ['default', 'start', 'end', 'decision', 'service', 'database', 'queue', 'user', 'agent', 'tool']
export const EDGE_KINDS = ['normal', 'async', 'dependency', 'error', 'bidirectional']
export const PARTICIPANT_KINDS = ['actor', 'service', 'database']
export const MESSAGE_KINDS = ['sync', 'async', 'return']
export const DIRECTIONS = ['top-down', 'left-right']

/** 默认数量/长度上限（config 可收紧，不可超过硬上限） */
export const HARD_LIMITS = {
  titleLen: 100, labelLen: 80, descLen: 200, captionLen: 200,
  maxNodes: 50, maxEdges: 100, maxGroups: 15, maxParticipants: 20, maxMessages: 100,
  idLen: 64,
}

/** 拒绝清单：HTML/脚本标签、协议头（label/title 里出现即拒——语义文本不需要 URL） */
const FORBIDDEN_TEXT = [
  /<\s*\/?\s*[a-z][a-z0-9-]*[^>]*>/i,      // HTML/XML 标签
  /<\s*(script|iframe|object|embed|svg|img|link|style|foreignobject)\b/i, // 危险元素名（含未闭合形态）
  /\bhttps?:\/\//i,                          // 外部 URL
  /\bdata:\s*[a-z]/i,                        // data: URL
  /\bjavascript:/i,
  /\bvbscript:/i,
  /&#|&#x|&lt;|&gt;/i,                        // 实体编码形态（防二次解码绕过）
]
export function stripControl(s) {
  return String(s ?? '').replace(/[\x00-\x1F\x7F-\x9F\u200b-\u200f\u2028\u2029\u2060-\u2064\ufeff]/g, '')
}

const err = (message, field = null) => ({ ok: false, errorClass: 'invalid_arguments', message, field, retryable: false })

// ─── zod 结构层 ───
const zText = (max, field) => z.string().transform(stripControl).refine((s) => s.length >= 1, { message: `${field} 不能为空` }).refine((s) => s.length <= max, { message: `${field} 超过 ${max} 字上限` })
const zOptText = (max) => z.string().transform(stripControl).refine((s) => s.length <= max, { message: `超过 ${max} 字上限` }).optional()
const zId = z.string().transform(stripControl).refine((s) => s.length >= 1 && s.length <= HARD_LIMITS.idLen, { message: `id 长度须为 1~${HARD_LIMITS.idLen}` })
  .refine((s) => !/[\/\\]|\.\./.test(s), { message: 'id 含路径分隔符或 ..' })
  .refine((s) => !/["'`;$<>{}()|]/.test(s), { message: 'id 含保留字符（引号/分号/括号等）' })

const NodeSchema = z.object({
  id: zId,
  label: zText(HARD_LIMITS.labelLen, 'label'),
  description: zOptText(HARD_LIMITS.descLen).optional(),
  kind: z.enum(NODE_KINDS).optional(),
  group: zId.optional(),
}).strict()

const EdgeSchema = z.object({
  from: zId,
  to: zId,
  label: zOptText(HARD_LIMITS.labelLen).optional(),
  kind: z.enum(EDGE_KINDS).optional(),
}).strict()

const GroupSchema = z.object({
  id: zId,
  label: zText(HARD_LIMITS.labelLen, 'label'),
  parent: zId.optional(),
}).strict()

const ParticipantSchema = z.object({
  id: zId,
  label: zText(HARD_LIMITS.labelLen, 'label'),
  kind: z.enum(PARTICIPANT_KINDS).optional(),
}).strict()

const MessageSchema = z.object({
  from: zId,
  to: zId,
  label: zText(HARD_LIMITS.labelLen, 'label'),
  kind: z.enum(MESSAGE_KINDS).optional(),
  order: z.number().int().finite().optional(),
}).strict()

const SpecSchema = z.object({
  version: z.literal(1).optional(),
  type: z.enum(DIAGRAM_TYPES),
  title: zText(HARD_LIMITS.titleLen, 'title'),
  direction: z.enum(DIRECTIONS).optional(),
  theme: z.enum(THEME_NAMES).optional(),
  nodes: z.array(NodeSchema).optional(),
  edges: z.array(EdgeSchema).optional(),
  groups: z.array(GroupSchema).optional(),
  participants: z.array(ParticipantSchema).optional(),
  messages: z.array(MessageSchema).optional(),
  caption: zOptText(HARD_LIMITS.captionLen).optional(),
  output: z.enum(['png', 'svg']).optional(),
}).strict()

/**
 * 校验 + 规范化 DiagramSpec。
 * @param {object} raw LLM 提交的原始 spec
 * @param {object} limits 上限（来自 config，可收紧；逐字段取 min(配置, 硬上限)）
 * @returns {{ok:true, spec, specHash}|{ok:false,errorClass,message,field,retryable}}
 */
export function validateSpec(raw, limits = {}) {
  const lim = {}
  for (const k of Object.keys(HARD_LIMITS)) lim[k] = Math.min(Number(limits[k]) > 0 ? Number(limits[k]) : HARD_LIMITS[k], HARD_LIMITS[k])

  const parsed = SpecSchema.safeParse(raw)
  if (!parsed.success) {
    const iss = parsed.error.issues[0]
    const field = iss.path.join('.')
    let msg = iss.message
    if (/^Invalid enum value/.test(iss.message)) {
      const vals = /expected one of \[(.*?)\]/i.exec(iss.message)?.[1] || ''
      msg = `${field || '字段'} 的值不合法，允许：${vals.replace(/"/g, '')}`
    } else if (/^Unrecognized key/.test(iss.message)) {
      return err(`包含未支持的字段：${/\'(.*?)\'/.exec(iss.message)?.[1] || ''}（只接受语义结构，不接受 SVG/HTML/路径等）`, field || null)
    }
    return err(msg, field || null)
  }
  const s = parsed.data

  // 文本拒绝清单（title/caption/label/description）
  const textCheck = (v, field) => {
    if (v == null) return null
    for (const re of FORBIDDEN_TEXT) if (re.test(v)) return err(`${field} 含被禁止的内容（HTML 标签 / 外部链接 / data: 协议），请用纯文本语义描述`, field)
    return null
  }
  let e = textCheck(s.title, 'title') || textCheck(s.caption, 'caption')
  if (e) return e
  if (s.title.length > lim.titleLen) return err(`title 超过 ${lim.titleLen} 字上限`, 'title')

  // 数量上限
  if ((s.nodes?.length || 0) > lim.maxNodes) return err(`节点数 ${s.nodes.length} 超过上限 ${lim.maxNodes}`, 'nodes')
  if ((s.edges?.length || 0) > lim.maxEdges) return err(`连线数 ${s.edges.length} 超过上限 ${lim.maxEdges}`, 'edges')
  if ((s.groups?.length || 0) > lim.maxGroups) return err(`分组数 ${s.groups.length} 超过上限 ${lim.maxGroups}`, 'groups')
  if ((s.participants?.length || 0) > lim.maxParticipants) return err(`参与者数 ${s.participants.length} 超过上限 ${lim.maxParticipants}`, 'participants')
  if ((s.messages?.length || 0) > lim.maxMessages) return err(`消息数 ${s.messages.length} 超过上限 ${lim.maxMessages}`, 'messages')
  for (const [i, n] of (s.nodes || []).entries()) {
    if (n.label.length > lim.labelLen) return err(`label 超过 ${lim.labelLen} 字上限`, `nodes[${i}].label`)
    const t = textCheck(n.label, `nodes[${i}].label`) || textCheck(n.description, `nodes[${i}].description`)
    if (t) return t
  }
  for (const [i, m] of (s.messages || []).entries()) {
    if (m.label.length > lim.labelLen) return err(`label 超过 ${lim.labelLen} 字上限`, `messages[${i}].label`)
    const t = textCheck(m.label, `messages[${i}].label`)
    if (t) return t
  }

  if (s.type === 'sequence') {
    // sequence：参与者/消息必填非空
    if (!s.participants?.length) return err('时序图必须提供 participants（至少 2 个）', 'participants')
    if (s.participants.length < 2) return err('时序图至少需要 2 个参与者', 'participants')
    if (!s.messages?.length) return err('时序图必须提供至少 1 条 message', 'messages')
    const ids = new Set()
    for (const [i, p] of s.participants.entries()) {
      if (ids.has(p.id)) return err(`参与者 id 重复：${p.id}`, `participants[${i}].id`)
      ids.add(p.id)
    }
    for (const [i, m] of s.messages.entries()) {
      if (!ids.has(m.from)) return err(`消息 from 引用了不存在的参与者 ${m.from}`, `messages[${i}].from`)
      if (!ids.has(m.to)) return err(`消息 to 引用了不存在的参与者 ${m.to}`, `messages[${i}].to`)
    }
  } else {
    if (!s.nodes?.length) return err(`${s.type} 图必须提供至少 1 个 node（空图拒绝渲染）`, 'nodes')
    const ids = new Set()
    for (const [i, n] of s.nodes.entries()) {
      if (ids.has(n.id)) return err(`节点 id 重复：${n.id}`, `nodes[${i}].id`)
      ids.add(n.id)
    }
    const groupIds = new Set()
    for (const [i, g] of (s.groups || []).entries()) {
      if (groupIds.has(g.id)) return err(`分组 id 重复：${g.id}`, `groups[${i}].id`)
      groupIds.add(g.id)
    }
    for (const [i, g] of (s.groups || []).entries()) {
      if (g.parent && !groupIds.has(g.parent)) return err(`分组 ${g.id} 的 parent 引用了不存在的分组 ${g.parent}`, `groups[${i}].parent`)
      // parent 链环检测
      const seen = new Set([g.id])
      let p = g.parent
      while (p) {
        if (seen.has(p)) return err(`分组 parent 链存在循环（涉及 ${g.id}）`, `groups[${i}].parent`)
        seen.add(p)
        p = (s.groups || []).find((x) => x.id === p)?.parent
      }
    }
    for (const [i, n] of s.nodes.entries()) {
      if (n.group && !groupIds.has(n.group)) return err(`节点 ${n.id} 的 group 引用了不存在的分组 ${n.group}`, `nodes[${i}].group`)
    }
    for (const [i, ed] of (s.edges || []).entries()) {
      if (!ids.has(ed.from)) return err(`连线 from 引用了不存在的节点 ${ed.from}`, `edges[${i}].from`)
      if (!ids.has(ed.to)) return err(`连线 to 引用了不存在的节点 ${ed.to}`, `edges[${i}].to`)
    }
  }

  return { ok: true, spec: canonicalize(s), specHash: hashSpec(s) }
}

/** canonicalize：补默认值、裁 undefined、稳定序列化（key 排序；数组保持声明顺序——顺序是语义的一部分） */
export function canonicalize(s) {
  const dir = s.direction || (s.type === 'architecture' || s.type === 'mindmap' ? 'left-right' : 'top-down')
  const out = { version: 1, type: s.type, title: s.title, direction: dir, theme: s.theme || DEFAULT_THEME }
  if (s.caption) out.caption = s.caption
  if (s.output) out.output = s.output
  if (s.type === 'sequence') {
    out.participants = s.participants.map((p) => clean({ id: p.id, label: p.label, kind: p.kind || 'service' }))
    // order 排序：JS sort 稳定 → comparator 只比较 order，同 order 严格保持声明顺序
    out.messages = s.messages
      .map((m, i) => ({ from: m.from, to: m.to, label: m.label, kind: m.kind || 'sync', order: Number.isFinite(m.order) ? m.order : i }))
      .sort((a, b) => a.order - b.order)
      .map((m) => clean({ from: m.from, to: m.to, label: m.label, kind: m.kind, order: m.order }))
  } else {
    out.nodes = s.nodes.map((n) => clean({ id: n.id, label: n.label, kind: n.kind || 'default', group: n.group, description: n.description }))
    out.edges = (s.edges || []).map((x) => clean({ from: x.from, to: x.to, label: x.label, kind: x.kind || 'normal' }))
    out.groups = (s.groups || []).map((g) => clean({ id: g.id, label: g.label, parent: g.parent }))
  }
  return sortDeep(out)
}

function clean(o) { const r = {}; for (const k of Object.keys(o).sort()) { if (o[k] !== undefined) r[k] = o[k] } return r }

/** 深度排序 key 的纯函数（数组保序） */
export function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep)
  if (v && typeof v === 'object') {
    const r = {}
    for (const k of Object.keys(v).sort()) r[k] = sortDeep(v[k])
    return r
  }
  return v
}

/** specHash：canonical JSON 的 sha256 前 16 位（日志/缓存键用，不回放正文） */
export function hashSpec(s) {
  const c = canonicalize(s)
  return createHash('sha256').update(JSON.stringify(c)).digest('hex').slice(0, 16)
}

/**
 * Skill —— 渐进式披露的"说明书 / 指令包"（"会不会做"），参考 OpenClaw AgentSkills 规范。
 *
 * 与 Tool（能力本身，模型直接调用执行）的根本区别：
 *   - Tool 是带类型定义、模型**直接调用执行**的函数（web_search/read/write…）。
 *   - Skill 是一段 **SKILL.md 指令**，它不新增动作，只教模型：什么场景用哪些工具、按什么顺序、
 *     有什么约束与最佳实践。
 *
 * 渐进式披露（让模型"主动调用 skill"的关键）：
 *   1. **目录始终可见**：所有 skill 的 name+description 编译成精简 `<available_skills>` 块，每轮
 *      注入 system prompt（catalog()）。模型由此"知道有哪些 skill、各自适用什么场景"。
 *   2. **按需加载正文**：模型匹配某 skill 描述时，调用 `skill` 工具按 name 加载其完整正文
 *      （makeSkillTool）——这就是"主动调用 skill"的通道。
 *   3. **兼容旧机制**：`always:true` 正文常驻；`when` 关键词/正则命中时正文额外自动注入
 *      （match/assemble），向后兼容且能抢先注入。
 *
 * Skill 契约（纯指令，无 execute）：
 *   { name, description, when, body, priority?, always? }
 *     description 触发短语（名词短语，说清"何时用"）；是目录里模型唯一能看到的判定依据，务必写好。
 *     when    可选：关键词/正则/数组，命中用户输入时抢先加载该说明书正文（向后兼容）。
 *             字符串 / 字符串数组 / RegExp / { keywords:[], regex:[], always:false }
 *     always  true 时正文常驻（慎用，会占上下文）
 *     body    markdown 指令正文（可引用 perception 注入的"运行能力盘点"等数据）
 *
 * 文件形态（skills/ 目录自动加载）：
 *   - *.md  ：YAML frontmatter（name/description/when/priority/always）+ markdown 正文
 *   - *.js  ：default export 一个 skill / 数组 / { name, description, when, body }
 */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// ─── XML 转义（目录注入用，防 description 含特殊字符破坏标签）───
function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// ─── frontmatter 值解析：支持 裸值 / 引号 / 行内数组 ───

/** 去除包裹引号（单/双），处理转义的双引号 */
function unquote(v) {
  const s = String(v ?? '').trim()
  if (!s) return ''
  if ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'")) {
    const inner = s.slice(1, -1)
    return s[0] === '"' ? inner.replace(/\\"/g, '"').replace(/\\n/g, '\n') : inner
  }
  return s
}

/** 行内数组 [a, b, c] → 字符串数组；非数组形态 → null */
function parseInlineArray(v) {
  const s = String(v ?? '').trim()
  if (!(s.startsWith('[') && s.endsWith(']'))) return null
  return s
    .slice(1, -1)
    .split(',')
    .map((x) => unquote(x.trim()))
    .filter(Boolean)
}

// ─── when 归一化 ───

/** 归一化 when → { always, keywords, regex } */
export function normalizeWhen(when, always) {
  if (always === true || when === 'always') return { always: true, keywords: [], regex: [] }
  if (!when) return { always: false, keywords: [], regex: [] }
  if (typeof when === 'string') return { always: false, keywords: parseInlineArray(when) || [when], regex: [] }
  if (when instanceof RegExp) return { always: false, keywords: [], regex: [when] }
  if (Array.isArray(when)) {
    const keywords = when.filter((w) => typeof w === 'string')
    const regex = when.filter((w) => w instanceof RegExp)
    return { always: false, keywords, regex }
  }
  if (typeof when === 'object') {
    return {
      always: !!when.always,
      keywords: [].concat(when.keywords || []).filter((w) => typeof w === 'string'),
      regex: [].concat(when.regex || []).filter((w) => w instanceof RegExp),
    }
  }
  return { always: false, keywords: [], regex: [] }
}

/** 定义一个 skill（说明书） */
export function defineSkill(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('defineSkill: 需对象')
  if (!spec.name || typeof spec.name !== 'string') throw new Error('defineSkill: 缺 name')
  if (!spec.body || typeof spec.body !== 'string') throw new Error(`defineSkill[${spec.name}]: 缺 body（指令正文）`)
  const desc = (spec.description || '').trim()
  return {
    name: spec.name,
    // description 是目录里模型唯一的判定依据；缺省时给出可用的兜底（而不是无信息）
    description: desc || `技能 ${spec.name}`,
    priority: spec.priority ?? 0,
    when: normalizeWhen(spec.when, spec.always),
    body: spec.body,
  }
}

// ─── 目录编译：移植 OpenClaw formatSkillsForPrompt（name+description 精简块）───

/** 截断过长的 description（skillhub 技能描述常很长），保持目录精简 */
function truncateDesc(desc, max = 80) {
  const s = String(desc || '').replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max) + '…' : s
}

/**
 * 把 skill 列表编译成注入 system prompt 的 `<available_skills>` 目录块。
 * 仅 name+description（~24 token/skill），让模型"看见有哪些 skill"。
 * @param {Array} skills skill 列表
 * @returns {string}
 */
export function formatCatalog(skills) {
  const list = (skills || []).filter(Boolean)
  if (!list.length) return ''
  const lines = [
    '',
    '以下技能（skills）为特定任务提供专门指引。',
    '当任务匹配某技能的 description 时，调用 `skill` 工具按其名称加载完整说明并遵循；没有匹配则不加载，不要臆造技能名。',
    '',
    '<available_skills>',
  ]
  for (const s of list) {
    lines.push('  <skill>')
    lines.push(`    <name>${escapeXml(s.name)}</name>`)
    lines.push(`    <description>${escapeXml(truncateDesc(s.description))}</description>`)
    lines.push('  </skill>')
  }
  lines.push('</available_skills>')
  return lines.join('\n')
}

export class SkillRegistry {
  constructor() {
    this.skills = new Map()
  }

  /** 注册（变参：单个/多个/数组）。始终经 defineSkill 归一化 when/always（对已定义对象幂等）。 */
  register(...skills) {
    for (const s of skills.flat(Infinity).filter(Boolean)) {
      const sk = defineSkill(s)
      this.skills.set(sk.name, sk)
    }
    return this
  }

  unregister(name) {
    return this.skills.delete(name)
  }

  has(name) {
    return this.skills.has(name)
  }

  get(name) {
    return this.skills.get(name) || null
  }

  list() {
    return [...this.skills.values()].sort((a, b) => b.priority - a.priority)
  }

  /** 所有 skill 的目录文本（每轮注入 system prompt，让模型看见可用 skill） */
  catalog() {
    return formatCatalog(this.list())
  }

  /** 判定单个 skill 是否匹配当前输入/标签（用于 always/when 抢先注入正文，向后兼容） */
  matches(skill, { input = '', tags = [] } = {}) {
    const w = skill.when
    if (w.always) return true
    const text = String(input || '')
    const tagSet = Array.isArray(tags) ? tags : []
    if (w.keywords.length) {
      const hay = text + ' ' + tagSet.join(' ')
      if (w.keywords.some((k) => hay.includes(k))) return true
    }
    if (w.regex.length) {
      if (w.regex.some((re) => re.test(text))) return true
    }
    // 无显式 when（如 SkillHub 安装的纯 name/description 技能）→ 用 name/description 派生关键词做发现
    if (!w.keywords.length && !w.regex.length) {
      const implicit = skill.__implicit || (skill.__implicit = deriveKeywords(skill))
      if (implicit.length) {
        const hay = text + ' ' + tagSet.join(' ')
        if (implicit.some((k) => hay.includes(k))) return true
      }
    }
    return false
  }

  /** 返回命中（always/when）的说明书（按 priority 降序），用于抢先注入正文 */
  match(env = {}) {
    return this.list().filter((s) => this.matches(s, env))
  }

  /** 把说明书拼成注入 prompt 的指令文本（skill 工具的返回也用此格式） */
  assemble(matches) {
    const list = matches || []
    if (!list.length) return ''
    return list
      .map((s) => `## 技能：${s.name}\n（适用场景：${s.description}）\n${s.body}`)
      .join('\n\n')
  }

  /** 加载单个 skill 的正文（skill 工具用） */
  loadBody(name) {
    const s = this.get(name)
    return s ? this.assemble([s]) : ''
  }

  /** 便捷：match + assemble 一步到位 */
  pick(env = {}) {
    return this.assemble(this.match(env))
  }
}

/**
 * 构造 `skill` 工具（模型主动调用 skill 的通道）。
 * 按 name 加载某 skill 的完整说明正文，返回指令文本。category: query（人人可用）。
 * @param {SkillRegistry} registry
 */
export function makeSkillTool(registry) {
  return {
    name: 'skill',
    description:
      '加载某项技能(skill)的完整说明。当任务匹配 <available_skills> 里某技能的 description 时调用它，按名称(name)加载该技能的完整指引并遵循。一次只加载最匹配的一个；不匹配不要调用。',
    category: 'query',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '要加载的技能名称（来自 <available_skills> 的 <name>）' },
      },
      required: ['name'],
    },
    async execute({ name } = {}) {
      const n = String(name || '').trim()
      if (!n) return { error: '缺少 name 参数' }
      const body = registry.loadBody(n)
      if (!body) return { error: `未找到技能「${n}」` }
      return body
    },
  }
}

// ─── SKILL.md 解析：健壮的 frontmatter（支持引号/行内数组/多行）+ 正文 ───

/**
 * 解析 frontmatter 键值行（支持 裸值 / "引号" / '引号' / [a,b] 行内数组）。
 * 多行值（缩进续行）合并到上一个 key（用于 description 等可能换行的场景）。
 */
function parseFrontmatter(fmText) {
  const meta = {}
  let lastKey = null
  for (const raw of fmText.split('\n')) {
    // 空行 / 注释
    if (!raw.trim() || raw.trim().startsWith('#')) continue
    // 缩进续行 → 追加到上一个 key（当值跨行时）
    if (lastKey && /^\s+\S/.test(raw) && !/^\s*[\w-]+\s*:/.test(raw)) {
      const cont = raw.trim()
      meta[lastKey] = meta[lastKey] ? `${meta[lastKey]} ${cont}` : cont
      continue
    }
    const idx = raw.indexOf(':')
    if (idx < 0) continue
    const k = raw.slice(0, idx).trim()
    if (!k) continue
    meta[k] = raw.slice(idx + 1).trim()
    lastKey = k
  }
  // 后处理：去引号 / 解析数组 / 布尔数字
  const out = {}
  for (const [k, v] of Object.entries(meta)) {
    const arr = parseInlineArray(v)
    if (arr != null) out[k] = arr
    else out[k] = unquote(v)
  }
  return out
}

/** 解析 SKILL.md：frontmatter + 正文 */
export function parseSkillMd(text, fallbackName) {
  const m = String(text || '').match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/)
  if (!m) {
    // 无 frontmatter：整篇当 body，名字用文件名
    return { name: fallbackName, description: '', when: [], priority: 0, always: false, body: (text || '').trim() }
  }
  const meta = parseFrontmatter(m[1])

  // when：兼容 when / keywords 两种键，接受 行内数组 / 逗号串
  const rawWhen = meta.when ?? meta.keywords
  let whenArr = []
  if (Array.isArray(rawWhen)) whenArr = rawWhen
  else if (typeof rawWhen === 'string') whenArr = rawWhen.split(',').map((s) => s.trim()).filter(Boolean)

  const always = String(meta.always).toLowerCase() === 'true'
  return {
    name: (meta.name || fallbackName || '').trim(),
    description: (meta.description || '').trim(),
    when: whenArr,
    priority: meta.priority != null && meta.priority !== '' ? Number(meta.priority) || 0 : 0,
    always,
    body: m[2].trim(),
  }
}

/**
 * 从目录加载 skill 包，支持两种形态（参考 OpenClaw AgentSkills）：
 *   - 扁平：顶层 `*.md`（说明书）/ `*.js`（工具包 export）
 *   - 目录型：任意深度的 `SKILL.md`（如 skillhub 安装的 `<name>/SKILL.md`）
 * 子目录里非 SKILL.md 的 .md（README/references/模板等）不当作技能加载。
 * 单文件失败跳过，不中断整体。
 */
export async function loadSkillPack(dir, { logger } = {}) {
  const log = logger || (() => {})
  const found = [] // {kind:'md'|'js', full, fallbackName?}
  const walk = (d, depth) => {
    if (depth > 4) return
    let entries = []
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue // 跳过 .skills_store_lock.json 等隐藏文件
      const full = path.resolve(d, ent.name)
      if (ent.isDirectory()) {
        walk(full, depth + 1)
      } else if (ent.isFile()) {
        const lower = ent.name.toLowerCase()
        if (lower === 'skill.md') {
          found.push({ kind: 'md', full, fallbackName: path.basename(d) })
        } else if (depth === 0 && /\.md$/.test(ent.name)) {
          found.push({ kind: 'md', full, fallbackName: ent.name.replace(/\.md$/i, '') })
        } else if (depth === 0 && /\.(js|mjs)$/.test(ent.name)) {
          found.push({ kind: 'js', full })
        }
        // 其余（子目录里的非 SKILL.md / 非顶层文件）跳过
      }
    }
  }
  walk(dir, 0)
  found.sort((a, b) => a.full.localeCompare(b.full))

  const out = []
  for (const item of found) {
    try {
      if (item.kind === 'js') {
        const mod = await import(pathToFileURL(item.full).href)
        const exp = mod?.default ?? mod?.skill ?? mod?.skills ?? mod
        const arr = Array.isArray(exp) ? exp : exp && typeof exp === 'object' ? [exp] : []
        for (const s of arr) {
          try { out.push(defineSkill(s)); log('info', `[skill] 加载 ${s.name}`) }
          catch (e) { log('warn', `[skill] 校验失败 ${item.full}:`, e?.message || e) }
        }
      } else {
        const raw = fs.readFileSync(item.full, 'utf8')
        const spec = parseSkillMd(raw, item.fallbackName)
        out.push(defineSkill(spec))
        log('info', `[skill] 加载 ${spec.name}`)
      }
    } catch (e) {
      log('error', `[skill] 加载失败 ${item.full}:`, e?.message || e)
    }
  }
  return out
}

/** 从 name/description 派生发现用关键词（用于无显式 when 的技能，如 SkillHub 安装的） */
export function deriveKeywords(skill) {
  const out = new Set()
  const push = (s) => {
    const t = String(s || '').trim()
    if (t) out.add(t)
  }
  // name：按 - _ / 拆分，取有意义的段
  for (const seg of String(skill.name || '').split(/[-_/\s]+/)) {
    if (seg.length >= 2) push(seg)
  }
  // description：抽取 CJK 连续段 + 英文单词
  const desc = String(skill.description || '')
  const cjk = desc.match(/[一-龥]{2,}/g) || []
  cjk.forEach(push)
  const words = desc.match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) || []
  words.forEach(push)
  return [...out].slice(0, 16)
}

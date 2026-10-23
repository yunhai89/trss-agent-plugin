/**
 * Enka 角色展柜 Agent 工具：原神 / 星穹铁道 / 绝区零。
 *
 * 输出给模型的是中文 markdown 摘要（玩家信息 + 展示角色），原始 JSON 不落上下文。
 * 仅能读取玩家公开在游戏展柜里的角色；未公开时 Enka 返回 404。
 */

import { fetchShowcase, ENKA_GAMES } from './client.js'
import Log from '../../utils/Log.js'

const MAX_CHARACTERS = 20

const REFINE_LABELS = { genshin: '精', hsr: '叠影', zzz: '改造' }

function fmtPlayer(player, meta) {
  const head = [player.nickname || '（未公开昵称）']
  if (player.level) head.push(`${meta.levelLabel} ${player.level}`)
  head.push(...(player.extra || []))
  return head.join(' · ')
}

function fmtWeapon(c, game) {
  if (!c.weapon?.name) return ''
  const refine = c.weapon.refine ? ` ${REFINE_LABELS[game]}${c.weapon.refine}` : ''
  // 绝区零音擎名本身常带「」，避免出现「「月相」-望」双重书名号
  const name = /^[「『]/.test(c.weapon.name) ? c.weapon.name : `「${c.weapon.name}」`
  const level = c.weapon.level ? `Lv.${c.weapon.level}` : ''
  return ` · ${ENKA_GAMES[game].weaponLabel}${name}${level}${refine}`
}

export function formatShowcase(result) {
  const meta = ENKA_GAMES[result.game]
  const lines = [`## ${meta.label} · UID ${result.uid}`, '']
  lines.push(fmtPlayer(result.player, meta))
  if (result.player.signature) lines.push(`> ${result.player.signature}`)
  lines.push('')

  const chars = result.characters || []
  if (!chars.length) {
    lines.push('公开角色展柜为空（玩家可能未开启展柜，或展柜里没有角色）。')
  } else {
    const shown = chars.slice(0, MAX_CHARACTERS)
    lines.push(`展示角色（${shown.length}${chars.length > shown.length ? `/${chars.length}` : ''}）：`)
    for (const c of shown) {
      const bits = [`Lv.${c.level || '?'}`]
      if (c.rarity) {
        // 绝区零的 Rarity 是 3=A / 4=S，不是星级，避免显示成“4★”
        if (result.game === 'zzz') bits.push(c.rarity >= 4 ? 'S级' : c.rarity === 3 ? 'A级' : `${c.rarity}★`)
        else bits.push(`${c.rarity}★`)
      }
      if (c.element) bits.push(c.element)
      if (c.role) bits.push(c.role)
      bits.push(`${meta.conLabel}${c.constellation || 0}`)
      let line = `- **${c.name}** ${bits.join(' · ')}`
      line += fmtWeapon(c, result.game)
      if (c.relicCount) line += ` · ${meta.relicLabel} ${c.relicCount}`
      lines.push(line)
    }
    if (chars.length > shown.length) lines.push(`- ……另有 ${chars.length - shown.length} 名角色未列出`)
  }

  lines.push('')
  const ttl = result.ttl ? ` · 缓存 TTL ${result.ttl}s` : ''
  lines.push(`> 数据来自 Enka.Network${ttl}${result.cached ? '（本次命中缓存）' : ''}；仅含公开角色展柜。`)
  return lines.join('\n')
}

function makeTool(game, description) {
  return {
    name: `enka_${game}`,
    description,
    category: 'query',
    meta: { resultCap: 12000 },
    parameters: {
      type: 'object',
      properties: {
        uid: { type: 'string', pattern: '^[1-9]\\d{7,9}$', description: '游戏 UID（8~10 位数字；绝区零国服 8 位）' },
      },
      required: ['uid'],
    },
    async execute(params, ctx) {
      const uid = String(params?.uid ?? '').trim()
      try {
        const result = await fetchShowcase(game, uid, { fetcher: ctx?.fetcher })
        return formatShowcase(result)
      } catch (e) {
        Log.warn(`[enka] ${game} ${uid || '?'} 查询失败：${e?.message || e}`)
        return `查询失败：${e?.message || e}`
      }
    },
  }
}

export const enkaGenshinTool = makeTool('genshin',
  '通过 UID 查询原神玩家的公开角色展柜（Enka.Network）。返回昵称、冒险等阶、签名，以及展示角色的名称/等级/稀有度/元素/命座/武器/圣遗物数量。只含玩家公开在展柜里的角色；UID 为 9~10 位数字。')

export const enkaHsrTool = makeTool('hsr',
  '通过 UID 查询《崩坏：星穹铁道》玩家的公开角色展柜（Enka.Network）。返回昵称、开拓等级、签名，以及展示角色的名称/等级/稀有度/属性/命途/星魂/光锥/遗器数量。只含公开展柜角色；UID 为 9~10 位数字。')

export const enkaZzzTool = makeTool('zzz',
  '通过 UID 查询《绝区零》玩家的公开代理人展柜（Enka.Network）。返回昵称、绳网等级、签名，以及展示代理人的名称/等级/稀有度/属性/职业/影画/音擎/驱动盘数量。只含公开展柜角色；UID 为 8~10 位数字（国服 8 位，国际服 10 位）。')

function fmtStat(s) {
  if (!s) return '—'
  return `${s.name} ${s.percent ? `${s.value}%` : s.value}`
}

function fmtRarity(game, rarity) {
  if (!rarity) return ''
  if (game === 'zzz') return rarity >= 4 ? 'S级' : rarity === 3 ? 'A级' : `${rarity}★`
  return `${rarity}★`
}

function setSummary(relics) {
  const counts = new Map()
  for (const r of relics) counts.set(r.setName, (counts.get(r.setName) || 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `${n}×${name}`)
    .join(' + ')
}

function substatSummary(relics) {
  const sums = new Map()
  for (const r of relics) {
    for (const s of r.subs || []) {
      const key = `${s.name}${s.percent ? '%' : ''}`
      const cur = sums.get(key) || { name: s.name, percent: s.percent, value: 0, count: 0 }
      cur.value += Number(s.value) || 0
      cur.count += 1
      sums.set(key, cur)
    }
  }
  const order = ['暴击率', '暴击伤害', '攻击力', '生命值', '防御力', '元素精通', '元素充能效率',
    '速度', '效果命中', '效果抵抗', '击破特攻', '穿透率', '穿透值', '异常精通', '异常掌控',
    '能量自动回复', '冲击力', '治疗加成', '治疗量加成']
  const rank = (name) => { const i = order.indexOf(name); return i < 0 ? 99 : i }
  return [...sums.values()]
    .sort((a, b) => rank(a.name) - rank(b.name) || b.value - a.value)
    .map((s) => `${s.name} +${Math.round(s.value * 10) / 10}${s.percent ? '%' : ''}×${s.count}`)
}

function critValue(relics) {
  let cv = 0
  let has = false
  for (const r of relics) {
    for (const s of r.subs || []) {
      if (!s.percent) continue
      if (s.name === '暴击率') { cv += Number(s.value) * 2; has = true }
      if (s.name === '暴击伤害') { cv += Number(s.value); has = true }
    }
  }
  return has ? Math.round(cv * 10) / 10 : null
}

/** 选择要分析的角色；不传 character 时仅在展柜只有一名角色时自动选中 */
function pickCharacter(result, query) {
  const chars = result.characters || []
  const q = String(query || '').trim()
  if (!q) return chars.length === 1 ? chars[0] : null
  const lower = q.toLowerCase()
  return chars.find((c) => c.id === q || c.name.toLowerCase() === lower || c.name.toLowerCase().includes(lower)) || null
}

export function formatBuild(result, char) {
  const meta = ENKA_GAMES[result.game]
  const lines = [`## ${meta.label} · ${char.name} Lv.${char.level || '?'} · ${meta.conLabel}${char.constellation || 0}`, '']
  lines.push(`玩家：${fmtPlayer(result.player, meta)}（UID ${result.uid}）`)
  if (result.player.signature) lines.push(`> ${result.player.signature}`)
  lines.push('')

  lines.push('### 武器')
  if (char.weapon?.name) {
    const refine = char.weapon.refine ? ` ${REFINE_LABELS[result.game]}${char.weapon.refine}` : ''
    lines.push(`- ${char.weapon.name}${refine} · Lv.${char.weapon.level || '?'}`)
    if (char.weapon.stats?.length) lines.push(`  - ${char.weapon.stats.map(fmtStat).join(' / ')}`)
  } else {
    lines.push('- 展柜中没有武器数据')
  }
  lines.push('')

  const relics = char.relics || []
  lines.push(`### ${meta.relicLabel}`)
  if (!relics.length) {
    lines.push('- 展柜中没有圣遗物/遗器/驱动盘数据')
  } else {
    lines.push(`- 套装：${setSummary(relics)}`)
    lines.push(`- 主词条：${relics.map((r) => `${r.slot} ${fmtStat(r.main)}`).join(' / ')}`)
    const subs = substatSummary(relics)
    if (subs.length) lines.push(`- 副词条合计：${subs.join(' · ')}`)
    const cv = critValue(relics)
    if (cv != null) lines.push(`- 副词条双暴分：${cv}（暴击率×2 + 暴击伤害）`)
    lines.push('')
    lines.push('逐件：')
    relics.forEach((r, i) => {
      const rarity = fmtRarity(result.game, r.rarity)
      const lv = result.game === 'genshin' ? Math.min(20, r.level || 0) : (r.level || 0)
      lines.push(`${i + 1}. **${r.slot}** · ${r.setName}${rarity ? ` ${rarity}` : ''} +${lv}`)
      lines.push(`   - 主：${fmtStat(r.main)}`)
      if (r.subs?.length) lines.push(`   - 副：${r.subs.map(fmtStat).join(' · ')}`)
    })
  }

  lines.push('')
  lines.push('> 以上是公开展柜快照，仅供配装分析；请结合角色定位、队伍与当前版本主流配装，给出需要替换的部件、目标主词条、副词条优先级与刷取顺序。')
  return lines.join('\n')
}

export const enkaBuildTool = {
  name: 'enka_build',
  description: '查看指定角色的完整配装（武器/光锥/音擎、逐件圣遗物/遗器/驱动盘的主副词条、命座/星魂/影画），用于诊断练度并让 LLM 给出优化方案。先用 enka_genshin/hsr/zzz 查看展柜角色名；character 传角色名或 ID；UID 为 8~10 位数字（绝区零国服 8 位）。',
  category: 'query',
  meta: { resultCap: 18000 },
  parameters: {
    type: 'object',
    properties: {
      uid: { type: 'string', pattern: '^[1-9]\\d{7,9}$', description: '游戏 UID（8~10 位数字；绝区零国服 8 位）' },
      game: { type: 'string', enum: ['genshin', 'hsr', 'zzz'], description: '游戏：genshin=原神，hsr=星穹铁道，zzz=绝区零' },
      character: { type: 'string', description: '角色名或 ID；展柜只有一名角色时可省略' },
    },
    required: ['uid', 'game'],
  },
  async execute(params, ctx) {
    const uid = String(params?.uid ?? '').trim()
    const game = String(params?.game ?? '').trim()
    try {
      const result = await fetchShowcase(game, uid, { fetcher: ctx?.fetcher })
      const char = pickCharacter(result, params?.character)
      if (!char) {
        const chars = result.characters || []
        if (!chars.length) {
          return '该玩家公开角色展柜为空，无法分析配装；需要玩家在游戏内把角色放进展示柜并确认公开。'
        }
        const names = chars.map((c) => c.name).join('、')
        if (params?.character) return `未找到角色「${params.character}」。该玩家展柜可选：${names}`
        return `该玩家展柜有 ${chars.length} 名角色：${names}。请用 character 参数指定要分析的角色。`
      }
      return formatBuild(result, char)
    } catch (e) {
      Log.warn(`[enka] build ${game} ${uid || '?'} 查询失败：${e?.message || e}`)
      return `查询失败：${e?.message || e}`
    }
  },
}

export const enkaTools = [enkaGenshinTool, enkaHsrTool, enkaZzzTool, enkaBuildTool]

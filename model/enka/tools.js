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
        uid: { type: 'string', pattern: '^[1-9]\\d{8,9}$', description: '游戏 UID（9~10 位数字）' },
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
  '通过 UID 查询《绝区零》玩家的公开代理人展柜（Enka.Network）。返回昵称、绳网等级、签名，以及展示代理人的名称/等级/稀有度/属性/职业/影画/音擎/驱动盘数量。只含公开展柜角色；UID 为 9~10 位数字。')

export const enkaTools = [enkaGenshinTool, enkaHsrTool, enkaZzzTool]

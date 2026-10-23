/**
 * Enka.Network 公开角色展柜客户端（零第三方依赖）。
 *
 * 端点：
 *   原神       GET https://enka.network/api/uid/{uid}/
 *   星穹铁道   GET https://enka.network/api/hsr/uid/{uid}/
 *   绝区零     GET https://enka.network/api/zzz/uid/{uid}/
 *
 * 规则（Enka 官方要求）：
 *  - 必须带可识别的 User-Agent；禁止枚举 UID、批量抓取；
 *  - 按响应里的 ttl 秒数缓存，ttl 内重复请求仍会消耗 Enka 配额；
 *  - 400=UID 格式错误、404=玩家不存在/未公开、424=维护、429=限流。
 */

import { VERSION } from '../../utils/version.js'
import {
  GI_CHARACTERS, GI_WEAPONS, GI_ELEMENTS, GI_WEAPON_TYPES,
  HSR_CHARACTERS, HSR_LIGHT_CONES, HSR_ELEMENTS, HSR_PATHS,
  ZZZ_CHARACTERS, ZZZ_W_ENGINES, ZZZ_ELEMENTS, ZZZ_PROFESSIONS,
  GAME_LABELS,
} from './data.js'

export const ENKA_USER_AGENT = `trss-agent-plugin/${VERSION} (+https://github.com/yunhai89/trss-agent-plugin)`
export const ENKA_TIMEOUT_MS = Math.min(120000, Math.max(5000, Number(process.env.ENKA_TIMEOUT_MS) || 40000))

export const ENKA_GAMES = {
  genshin: { label: GAME_LABELS.genshin, path: 'uid', levelLabel: '冒险等阶', conLabel: '命座', weaponLabel: '武器', relicLabel: '圣遗物' },
  hsr: { label: GAME_LABELS.hsr, path: 'hsr/uid', levelLabel: '开拓等级', conLabel: '星魂', weaponLabel: '光锥', relicLabel: '遗器' },
  zzz: { label: GAME_LABELS.zzz, path: 'zzz/uid', levelLabel: '绳网等级', conLabel: '影画', weaponLabel: '音擎', relicLabel: '驱动盘' },
}

const CACHE_MAX_TTL = 600 // 秒；Enka ttl 偶发很大，避免长期不刷新
const cache = new Map()

export class EnkaError extends Error {
  constructor(message, { code = 'enka_error', status = 0 } = {}) {
    super(message)
    this.name = 'EnkaError'
    this.code = code
    this.status = status
  }
}

export function clearEnkaCache() { cache.clear() }

export function assertUid(uid) {
  const s = String(uid ?? '').trim()
  if (!/^[1-9]\d{8,9}$/.test(s)) {
    throw new EnkaError('UID 应为 9~10 位数字（原神/星铁通常 9 位，绝区零 10 位）', { code: 'bad_uid', status: 400 })
  }
  return s
}

function httpError(status, detail = '') {
  const tail = detail ? `（${detail}）` : ''
  if (status === 400) return new EnkaError(`UID 格式不正确${tail}`, { code: 'bad_uid', status })
  if (status === 404) return new EnkaError(`玩家不存在，或未开启公开角色展柜${tail}`, { code: 'not_found', status })
  if (status === 424) return new EnkaError(`Enka 正在维护，暂时无法查询${tail}`, { code: 'maintenance', status })
  if (status === 429) return new EnkaError(`请求过于频繁，被 Enka 限流；请稍后再试${tail}`, { code: 'rate_limited', status })
  if (status >= 500) return new EnkaError(`Enka 服务暂时不可用（HTTP ${status}）${tail}`, { code: 'upstream', status })
  return new EnkaError(`Enka 请求失败（HTTP ${status}）${tail}`, { code: 'http_error', status })
}

async function readErrorDetail(res) {
  try {
    if (typeof res.text !== 'function') return ''
    const text = String(await res.text() || '').trim()
    if (!text || text.length > 300) return ''
    try {
      const j = JSON.parse(text)
      return String(j.message || j.detail || j.code || '').slice(0, 120)
    } catch { return text.slice(0, 120) }
  } catch { return '' }
}

function makeSignal(timeoutMs, outer) {
  let signal
  try { signal = AbortSignal.timeout(timeoutMs) } catch { signal = undefined }
  if (outer && signal) return AbortSignal.any([outer, signal])
  return outer || signal
}

function pickChar(map, id) { return map[String(id)] || {} }

export function normalizeGenshin(data, uid) {
  const pi = data?.playerInfo || {}
  const characters = (Array.isArray(data?.avatarInfoList) ? data.avatarInfoList : []).map((a) => {
    const info = pickChar(GI_CHARACTERS, a.avatarId)
    const equip = Array.isArray(a.equipList) ? a.equipList : []
    const weaponEq = equip.find((x) => x?.weapon)
    const weaponInfo = weaponEq ? pickChar(GI_WEAPONS, weaponEq.itemId) : {}
    const affix = weaponEq?.weapon?.affixMap ? Object.values(weaponEq.weapon.affixMap)[0] : null
    return {
      id: String(a.avatarId),
      name: info.n || `角色#${a.avatarId}`,
      level: Number(a.propMap?.['4001']?.val) || 0,
      rarity: info.r || 0,
      element: GI_ELEMENTS[info.e] || info.e || '',
      role: GI_WEAPON_TYPES[info.w] || info.w || '',
      constellation: Array.isArray(a.talentIdList) ? a.talentIdList.length : 0,
      weapon: weaponEq ? {
        name: weaponInfo.n || `武器#${weaponEq.itemId}`,
        level: Number(weaponEq.weapon?.level) || 0,
        refine: affix == null ? 0 : Number(affix) + 1,
      } : null,
      relicCount: equip.filter((x) => x?.reliquary).length,
    }
  })
  return {
    game: 'genshin',
    gameLabel: GAME_LABELS.genshin,
    uid,
    ttl: Number(data?.ttl) || 0,
    player: {
      nickname: pi.nickname || '',
      level: Number(pi.level) || 0,
      signature: pi.signature || '',
      extra: [
        pi.worldLevel ? `世界等级 ${pi.worldLevel}` : '',
        pi.finishAchievementNum ? `成就 ${pi.finishAchievementNum}` : '',
      ].filter(Boolean),
    },
    characters,
  }
}

export function normalizeHsr(data, uid) {
  const di = data?.detailInfo || {}
  const characters = (Array.isArray(di.avatarDetailList) ? di.avatarDetailList : []).map((a) => {
    const info = pickChar(HSR_CHARACTERS, a.avatarId)
    const lc = a.equipment
    const lcInfo = lc ? pickChar(HSR_LIGHT_CONES, lc.tid) : {}
    return {
      id: String(a.avatarId),
      name: info.n || `角色#${a.avatarId}`,
      level: Number(a.level) || 0,
      rarity: info.r || 0,
      element: HSR_ELEMENTS[info.e] || info.e || '',
      role: HSR_PATHS[info.p] || info.p || '',
      constellation: Number(a.rank) || 0,
      weapon: lc ? {
        name: lcInfo.n || `光锥#${lc.tid}`,
        level: Number(lc.level) || 0,
        refine: Number(lc.rank) || 0,
      } : null,
      relicCount: Array.isArray(a.relicList) ? a.relicList.length : 0,
    }
  })
  return {
    game: 'hsr',
    gameLabel: GAME_LABELS.hsr,
    uid,
    ttl: Number(data?.ttl) || 0,
    player: {
      nickname: di.nickname || '',
      level: Number(di.level) || 0,
      signature: di.signature || '',
      extra: [di.worldLevel ? `均衡等级 ${di.worldLevel}` : ''].filter(Boolean),
    },
    characters,
  }
}

export function normalizeZzz(data, uid) {
  const pi = data?.PlayerInfo || data?.playerInfo || {}
  const social = pi.SocialDetail || {}
  const profile = social.ProfileDetail || {}
  const avatars = Array.isArray(pi.ShowcaseDetail?.AvatarList) ? pi.ShowcaseDetail.AvatarList : []
  const characters = avatars.map((a) => {
    const info = pickChar(ZZZ_CHARACTERS, a.Id)
    const w = a.Weapon
    const wInfo = w ? pickChar(ZZZ_W_ENGINES, w.Id) : {}
    return {
      id: String(a.Id),
      name: info.n || `代理人#${a.Id}`,
      level: Number(a.Level) || 0,
      rarity: info.r || 0,
      element: ZZZ_ELEMENTS[info.e] || info.e || '',
      role: ZZZ_PROFESSIONS[info.p] || info.p || '',
      constellation: Number(a.TalentLevel) || 0,
      weapon: w ? {
        name: wInfo.n || `音擎#${w.Id}`,
        level: Number(w.Level) || 0,
        refine: Number(w.BreakLevel) || 0,
      } : null,
      relicCount: Array.isArray(a.EquippedList) ? a.EquippedList.length : 0,
    }
  })
  return {
    game: 'zzz',
    gameLabel: GAME_LABELS.zzz,
    uid,
    ttl: Number(data?.ttl) || 0,
    player: {
      nickname: profile.Nickname || '',
      level: Number(profile.Level) || 0,
      signature: social.Desc || '',
      extra: [],
    },
    characters,
  }
}

export const NORMALIZERS = { genshin: normalizeGenshin, hsr: normalizeHsr, zzz: normalizeZzz }

/**
 * 查询并归一化一个玩家的公开角色展柜。
 * @param {'genshin'|'hsr'|'zzz'} game
 * @param {string|number} uid
 * @param {{ fetcher?: Function, timeoutMs?: number, signal?: AbortSignal, cache?: boolean }} opts
 */
export async function fetchShowcase(game, uid, opts = {}) {
  const meta = ENKA_GAMES[game]
  if (!meta) throw new EnkaError(`不支持的游戏：${game}`, { code: 'bad_game', status: 400 })
  const id = assertUid(uid)
  const fetcher = opts.fetcher || globalThis.fetch
  if (typeof fetcher !== 'function') throw new EnkaError('当前运行环境没有可用的 fetch', { code: 'no_fetch' })

  const cacheKey = `${game}:${id}`
  if (opts.cache !== false) {
    const hit = cache.get(cacheKey)
    if (hit && Date.now() < hit.expiresAt) return { ...hit.data, cached: true }
  }

  const url = `https://enka.network/api/${meta.path}/${id}/`
  const timeoutMs = Math.min(120000, Math.max(1000, Number(opts.timeoutMs) || ENKA_TIMEOUT_MS))
  let res
  try {
    res = await fetcher(url, {
      headers: { 'User-Agent': ENKA_USER_AGENT, Accept: 'application/json' },
      signal: makeSignal(timeoutMs, opts.signal),
    })
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      throw new EnkaError(`Enka 响应超时（${Math.round(timeoutMs / 1000)}s），可能是网络或 Enka 繁忙，请稍后重试`, { code: 'timeout' })
    }
    throw new EnkaError(`连接 Enka 失败：${e?.message || e}`, { code: 'network' })
  }

  if (!res || !res.ok) {
    const status = Number(res?.status) || 0
    throw httpError(status, await readErrorDetail(res))
  }

  let data
  try { data = await res.json() } catch (e) {
    throw new EnkaError(`Enka 返回了无法解析的数据：${e?.message || e}`, { code: 'bad_json', status: res.status })
  }

  const result = NORMALIZERS[game](data, id)
  result.fetchedAt = Date.now()
  const ttl = Math.min(CACHE_MAX_TTL, Math.max(0, result.ttl || 0))
  result.ttl = ttl
  if (ttl > 0) cache.set(cacheKey, { data: result, expiresAt: Date.now() + ttl * 1000 })
  return result
}

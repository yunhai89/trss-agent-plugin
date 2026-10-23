/**
 * Enka.Network 公共出口 —— 原神 / 星穹铁道 / 绝区零角色展柜查询。
 *
 * 用法（apps 层）：
 *   import { enkaTools } from '../model/enka/index.js'
 *   tools.register(...enkaTools)
 *
 * 公开接口无需 API Key；客户端自带 User-Agent、超时与 ttl 缓存。
 */

import {
  ENKA_GAMES, ENKA_USER_AGENT, ENKA_TIMEOUT_MS, EnkaError,
  fetchShowcase, assertUid, clearEnkaCache,
  normalizeGenshin, normalizeHsr, normalizeZzz, NORMALIZERS,
} from './client.js'
import { enkaGenshinTool, enkaHsrTool, enkaZzzTool, enkaTools, formatShowcase } from './tools.js'
import {
  GAME_LABELS, ENKA_DATA_UPDATED,
  GI_CHARACTERS, GI_WEAPONS, GI_ELEMENTS, GI_WEAPON_TYPES,
  HSR_CHARACTERS, HSR_LIGHT_CONES, HSR_ELEMENTS, HSR_PATHS,
  ZZZ_CHARACTERS, ZZZ_W_ENGINES, ZZZ_ELEMENTS, ZZZ_PROFESSIONS,
} from './data.js'

export {
  ENKA_GAMES, ENKA_USER_AGENT, ENKA_TIMEOUT_MS, EnkaError,
  fetchShowcase, assertUid, clearEnkaCache,
  normalizeGenshin, normalizeHsr, normalizeZzz, NORMALIZERS,
  enkaGenshinTool, enkaHsrTool, enkaZzzTool, enkaTools, formatShowcase,
  GAME_LABELS, ENKA_DATA_UPDATED,
  GI_CHARACTERS, GI_WEAPONS, GI_ELEMENTS, GI_WEAPON_TYPES,
  HSR_CHARACTERS, HSR_LIGHT_CONES, HSR_ELEMENTS, HSR_PATHS,
  ZZZ_CHARACTERS, ZZZ_W_ENGINES, ZZZ_ELEMENTS, ZZZ_PROFESSIONS,
}

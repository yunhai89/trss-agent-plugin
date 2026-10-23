/**
 * Enka 展柜内置数据：三游戏的角色 / 武器中文名与基础属性。
 *
 * data.json 由 EnkaNetwork/API-docs（store/gi、store/hsr、store/zzz）与
 * Mar-7th/StarRailRes（index_min/cn）在构建时提取，只保留渲染需要的字段，
 * 避免运行时依赖 GitHub（国内网络不可靠）与 1MB 级原始数据。
 *
 * 字段缩写：
 *   n=名称 r=稀有度 e=元素 w=武器类型 p=命途/职业
 */

import { readFileSync } from 'node:fs'

const raw = JSON.parse(readFileSync(new URL('./data.json', import.meta.url), 'utf8'))

export const ENKA_DATA_UPDATED = raw.updated || ''

export const GI_CHARACTERS = raw.genshin?.characters || {}
export const GI_WEAPONS = raw.genshin?.weapons || {}
export const HSR_CHARACTERS = raw.hsr?.characters || {}
export const HSR_LIGHT_CONES = raw.hsr?.lightCones || {}
export const ZZZ_CHARACTERS = raw.zzz?.characters || {}
export const ZZZ_W_ENGINES = raw.zzz?.wEngines || {}

/* 展示层中文映射；缺项时回退原始英文值，避免新角色直接显示为空 */

export const GI_ELEMENTS = {
  Ice: '冰', Fire: '火', Water: '水', Wind: '风', Rock: '岩', Grass: '草',
  Electro: '雷', Electric: '雷', None: '',
}

export const GI_WEAPON_TYPES = {
  WEAPON_SWORD_ONE_HAND: '单手剑',
  WEAPON_CLAYMORE: '双手剑',
  WEAPON_POLE: '长柄武器',
  WEAPON_BOW: '弓',
  WEAPON_CATALYST: '法器',
}

export const HSR_ELEMENTS = {
  Physical: '物理', Fire: '火', Ice: '冰', Lightning: '雷', Thunder: '雷',
  Wind: '风', Quantum: '量子', Imaginary: '虚数',
}

export const HSR_PATHS = {
  Warrior: '毁灭', Rogue: '巡猎', Mage: '智识', Shaman: '同谐',
  Warlock: '虚无', Knight: '存护', Priest: '丰饶', Memory: '记忆', Elation: '欢愉',
}

export const ZZZ_ELEMENTS = {
  Physical: '物理', Physics: '物理', Fire: '火', Ice: '冰', Elec: '电', Ether: '以太',
  Frost: '霜寒', FireFrost: '烈霜', AuricEther: '玄墨', Lumen: '流明',
  ZhenZhenAssault: '震击', Wind: '风',
}

export const ZZZ_PROFESSIONS = {
  Attack: '强攻', Stun: '击破', Anomaly: '异常', Support: '支援', Defense: '防护',
  Rupture: '命破', Armorer: '防护',
}

export const GAME_LABELS = {
  genshin: '原神',
  hsr: '崩坏：星穹铁道',
  zzz: '绝区零',
}

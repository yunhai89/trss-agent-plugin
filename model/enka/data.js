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
export const GI_SETS = raw.giSets || {}
export const HSR_SETS = raw.hsrSets || {}
export const ZZZ_SUITS = raw.zzzSuits || {}
export const ZZZ_ITEMS = raw.zzzItems || {}

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

/* 圣遗物/遗器/驱动盘主副词条中文名与百分比标记（[名称, 是否百分比]） */
export const GI_STATS = {
  FIGHT_PROP_BASE_ATTACK: ['基础攻击力', false],
  FIGHT_PROP_HP: ['生命值', false],
  FIGHT_PROP_HP_PERCENT: ['生命值', true],
  FIGHT_PROP_ATTACK: ['攻击力', false],
  FIGHT_PROP_ATTACK_PERCENT: ['攻击力', true],
  FIGHT_PROP_DEFENSE: ['防御力', false],
  FIGHT_PROP_DEFENSE_PERCENT: ['防御力', true],
  FIGHT_PROP_CRITICAL: ['暴击率', true],
  FIGHT_PROP_CRITICAL_HURT: ['暴击伤害', true],
  FIGHT_PROP_ELEMENT_MASTERY: ['元素精通', false],
  FIGHT_PROP_CHARGE_EFFICIENCY: ['元素充能效率', true],
  FIGHT_PROP_HEAL_ADD: ['治疗加成', true],
  FIGHT_PROP_PHYSICAL_ADD_HURT: ['物理伤害加成', true],
  FIGHT_PROP_FIRE_ADD_HURT: ['火元素伤害加成', true],
  FIGHT_PROP_ELEC_ADD_HURT: ['雷元素伤害加成', true],
  FIGHT_PROP_WATER_ADD_HURT: ['水元素伤害加成', true],
  FIGHT_PROP_GRASS_ADD_HURT: ['草元素伤害加成', true],
  FIGHT_PROP_WIND_ADD_HURT: ['风元素伤害加成', true],
  FIGHT_PROP_ROCK_ADD_HURT: ['岩元素伤害加成', true],
  FIGHT_PROP_ICE_ADD_HURT: ['冰元素伤害加成', true],
}

export const HSR_STATS = {
  BaseHP: ['基础生命值', false], BaseAttack: ['基础攻击力', false], BaseDefence: ['基础防御力', false],
  HPDelta: ['生命值', false], HPAddedRatio: ['生命值', true],
  AttackDelta: ['攻击力', false], AttackAddedRatio: ['攻击力', true],
  DefenceDelta: ['防御力', false], DefenceAddedRatio: ['防御力', true],
  CriticalChance: ['暴击率', true], CriticalDamage: ['暴击伤害', true],
  SpeedDelta: ['速度', false],
  StatusProbability: ['效果命中', true], StatusResistance: ['效果抵抗', true],
  BreakDamageAddedRatio: ['击破特攻', true], HealRatio: ['治疗量加成', true],
  PhysicalAddedRatio: ['物理属性伤害提高', true], FireAddedRatio: ['火属性伤害提高', true],
  IceAddedRatio: ['冰属性伤害提高', true], ThunderAddedRatio: ['雷属性伤害提高', true],
  WindAddedRatio: ['风属性伤害提高', true], QuantumAddedRatio: ['量子属性伤害提高', true],
  ImaginaryAddedRatio: ['虚数属性伤害提高', true],
}

export const ZZZ_STATS = {
  11103: ['生命值', false], 11102: ['生命值', true],
  12103: ['攻击力', false], 12102: ['攻击力', true],
  13103: ['防御力', false], 13102: ['防御力', true],
  20103: ['暴击率', true], 21103: ['暴击伤害', true],
  23103: ['穿透率', true], 23203: ['穿透值', false],
  30502: ['能量自动回复', true], 30603: ['治疗加成', true],
  31203: ['异常精通', false], 31303: ['异常积蓄效率', true], 31402: ['异常掌控', true],
  31503: ['物理伤害加成', true], 31603: ['火属性伤害加成', true], 31703: ['冰属性伤害加成', true],
  31803: ['电属性伤害加成', true], 31903: ['以太属性伤害加成', true], 32303: ['风属性伤害加成', true],
  12203: ['冲击力', false],
}

export const GI_SLOTS = {
  EQUIP_BRACER: '生之花', EQUIP_NECKLACE: '死之羽', EQUIP_SHOES: '时之沙',
  EQUIP_RING: '空之杯', EQUIP_DRESS: '理之冠',
}

export const HSR_SLOTS = {
  1: '头部', 2: '手部', 3: '躯干', 4: '脚部', 5: '位面球', 6: '连结绳',
}

export const GAME_LABELS = {
  genshin: '原神',
  hsr: '崩坏：星穹铁道',
  zzz: '绝区零',
}

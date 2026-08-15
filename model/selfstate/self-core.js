/**
 * SelfCoreCompiler —— 角色卡 → 结构化稳定自我（设计文档 v1.1 §5.1、§6.1）。
 *
 * SelfModel 是"我是谁、我在意什么"，变化极慢（只随人设变更重编译），运行时 Planner 不读完整人格文本。
 * 编译策略（成本递增、全降级安全）：
 *   1. persona_version（人设文本 sha256 短哈希）命中缓存 → 直接返回；
 *   2. 关键词启发式从角色卡提取气质倾向（如出现「记仇/小心眼」→ rumination↑；「随和/大度」→ forgiveness↑）；
 *   3. 有 provider 时低频 LLM 结构化编译（保存/变更时一次）；
 *   4. 任何失败回落 DEFAULT_TEMPERAMENT（温和中立）——SS 绝不因编译失败不可用。
 * temperament 8 维全 0~1（§6.1），描述反应倾向而非实时情绪。
 */
import { createHash } from 'node:crypto'
import Log from '../../utils/Log.js'
import { SELF_CORE_SYSTEM, parseCoreOutput } from './prompts.js'

export const DEFAULT_TEMPERAMENT = Object.freeze({
  reactivity: 0.48,             // 情绪反应速度
  recovery_speed: 0.62,         // 恢复速度（半衰期调制）
  expressiveness: 0.44,         // 情绪表达程度
  rejection_sensitivity: 0.38,  // 被拒绝敏感
  disrespect_sensitivity: 0.66, // 被不敬敏感
  rumination: 0.31,             // 反刍（负面停留）
  forgiveness: 0.58,            // 原谅倾向
  conflict_avoidance: 0.42,     // 回避冲突
})

/** 关键词启发式：角色卡文本 → 气质偏置（叠加在默认之上，钳 0~1）。 */
const KEYWORD_BIAS = [
  [/记仇|小心眼|爱计较|睚眦/, { rumination: +0.25, forgiveness: -0.2 }],
  [/大度|宽容|不计较|随和|好说话/, { forgiveness: +0.2, rumination: -0.15 }],
  [/暴脾气|易怒|急性子|火爆/, { reactivity: +0.25, disrespect_sensitivity: +0.15, conflict_avoidance: -0.2 }],
  [/温和|慢热|淡定|冷静|稳重/, { reactivity: -0.2, recovery_speed: +0.1, conflict_avoidance: +0.15 }],
  [/敏感|玻璃心|多想|内耗/, { rejection_sensitivity: +0.25, rumination: +0.15 }],
  [/皮|爱损人|毒舌|嘴硬|爱怼/, { expressiveness: +0.2, conflict_avoidance: -0.15 }],
  [/内向|安静|不爱说话|高冷/, { expressiveness: -0.25 }],
  [/热情|自来熟|话痨/, { expressiveness: +0.2, reactivity: +0.1 }],
  [/记性好|爱翻旧账/, { rumination: +0.2 }],
  [/爱恨分明|恩怨分明/, { rumination: +0.1, forgiveness: -0.15 }],
]

function heuristicTemperament(roleCard) {
  const t = { ...DEFAULT_TEMPERAMENT }
  const text = String(roleCard || '')
  for (const [re, bias] of KEYWORD_BIAS) {
    if (re.test(text)) {
      for (const [k, d] of Object.entries(bias)) {
        if (k in t) t[k] = Math.max(0.05, Math.min(0.95, t[k] + d))
      }
    }
  }
  return t
}

/** persona_version：人设文本稳定短哈希。 */
export function personaVersion(personaText) {
  return createHash('sha256').update(String(personaText || '').trim()).digest('hex').slice(0, 12)
}

export class SelfCoreCompiler {
  /**
   * @param {object} opts { dao, provider?, model?, logger? }
   */
  constructor({ dao, provider = null, model = null } = {}) {
    if (!dao) throw new Error('SelfCoreCompiler 需要 dao')
    this.dao = dao
    this.provider = provider
    this.model = model
  }

  /**
   * 取（必要时编译）自我核心。绝不抛错——失败返回默认核心。
   * @param {object} o { botId, personaText, personaName?, behaviorStyle? }
   * @returns {Promise<{temperament, identitySummary, values, boundaries, sensitivities, copingStyle, emotionalBaseline, version, source:'cache'|'heuristic'|'llm'|'default'}>}
   */
  async getOrCompile({ botId, personaText = '', personaName = '', behaviorStyle = '' }) {
    const version = personaVersion(`${personaText}|${personaName}`)
    const fallback = () => ({
      temperament: heuristicTemperament(personaText),
      identitySummary: personaName ? `群聊角色「${personaName}」` : '群聊参与者',
      values: [], boundaries: [], sensitivities: [], copingStyle: { default: '按角色性格自然应对' },
      emotionalBaseline: { valence: 0, arousal: 0.2, energy: 0.7, social_security: 0.6, agency: 0.6 },
      version, source: personaText ? 'heuristic' : 'default',
    })
    try {
      const cached = await this.dao.get('SELECT * FROM ss_self_core WHERE bot_id=?', [botId])
      if (cached && cached.persona_version === version) return this._rowToCore(cached, 'cache')

      // 编译（LLM 可选增强，启发式兜底）
      let core = fallback()
      if (this.provider && String(personaText || '').trim().length >= 20) {
        try {
          const llmCore = await this._compileWithLlm(personaText, behaviorStyle)
          if (llmCore) core = llmCore
        } catch (e) { Log.warn('[selfstate] LLM 编译失败，回落启发式', e?.message || e) }
      }

      // 持久化（幂等 upsert）
      const now = Date.now()
      await this.dao.run(
        `INSERT INTO ss_self_core(bot_id,persona_version,identity_summary,values_json,boundaries_json,sensitivities_json,coping_style_json,emotional_baseline_json,temperament_json,compiled_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(bot_id) DO UPDATE SET persona_version=excluded.persona_version, identity_summary=excluded.identity_summary,
           values_json=excluded.values_json, boundaries_json=excluded.boundaries_json, sensitivities_json=excluded.sensitivities_json,
           coping_style_json=excluded.coping_style_json, emotional_baseline_json=excluded.emotional_baseline_json,
           temperament_json=excluded.temperament_json, compiled_at=excluded.compiled_at, updated_at=excluded.updated_at`,
        [botId, version, core.identitySummary, JSON.stringify(core.values || []), JSON.stringify(core.boundaries || []),
          JSON.stringify(core.sensitivities || []), JSON.stringify(core.copingStyle || {}), JSON.stringify(core.emotionalBaseline || {}),
          JSON.stringify(core.temperament), now, now],
      )
      return core
    } catch (e) {
      Log.warn('[selfstate] self core 读取/编译失败，用默认', e?.message || e)
      return fallback()
    }
  }

  async _compileWithLlm(personaText, behaviorStyle) {
    const res = await this.provider.chat({
      model: this.model || undefined,
      system: SELF_CORE_SYSTEM,
      messages: [{ role: 'user', content: `角色卡：\n${personaText}\n\n行为风格：\n${behaviorStyle || '(未提供)'}` }],
      tools: undefined, tool_choice: { mode: 'none' },
      temperature: 0.2, max_tokens: 700, thinking: { type: 'disabled' }, stream: false,
    })
    const parsed = parseCoreOutput(res?.content || '')
    if (!parsed) return null
    // 与启发式合成：LLM 值为主，缺项回落启发式
    const heuristic = heuristicTemperament(personaText)
    const temperament = {}
    for (const k of Object.keys(DEFAULT_TEMPERAMENT)) {
      const v = Number(parsed.temperament?.[k])
      temperament[k] = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : heuristic[k]
    }
    return {
      temperament,
      identitySummary: String(parsed.identity_summary || '').slice(0, 500) || `群聊角色`,
      values: (Array.isArray(parsed.values) ? parsed.values : []).slice(0, 8).map((x) => String(x).slice(0, 60)),
      boundaries: (Array.isArray(parsed.boundaries) ? parsed.boundaries : []).slice(0, 8).map((x) => String(x).slice(0, 60)),
      sensitivities: (Array.isArray(parsed.sensitivities) ? parsed.sensitivities : []).slice(0, 8).map((x) => String(x).slice(0, 60)),
      copingStyle: parsed.coping_style && typeof parsed.coping_style === 'object' ? parsed.coping_style : { default: '按角色性格自然应对' },
      emotionalBaseline: { valence: 0, arousal: 0.2, energy: 0.7, social_security: 0.6, agency: 0.6 },
      version: null, // 由调用方填
      source: 'llm',
    }
  }

  _rowToCore(row, source) {
    const jp = (s, d) => { try { const v = JSON.parse(s); return v ?? d } catch { return d } }
    return {
      temperament: { ...DEFAULT_TEMPERAMENT, ...jp(row.temperament_json, {}) },
      identitySummary: row.identity_summary,
      values: jp(row.values_json, []), boundaries: jp(row.boundaries_json, []),
      sensitivities: jp(row.sensitivities_json, []), copingStyle: jp(row.coping_style_json, {}),
      emotionalBaseline: jp(row.emotional_baseline_json, {}),
      version: row.persona_version, source,
    }
  }
}

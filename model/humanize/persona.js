/**
 * 伪人角色人设解析（纯函数，便于单测）。
 *
 * 来源优先级：
 *   1. persona.fromPersonaId —— 人设库（PersonaStore）命中且 systemPrompt 非空；
 *   2. persona.prompt      —— 面板里的自定义角色卡；
 *   3. DEFAULT_HUMANIZE_PERSONA —— 内置默认（去 AI 味，保证开箱有真人感）。
 *
 * 人设库模式下 name 也以库中名称为准：@/昵称判定、Planner、Replyer 与正文同源，
 * 避免「正文叫人设名、@ 判定用旧名」两套身份。
 */

import { resolvePersonaIdentity } from './default-config.js'
import { DEFAULT_HUMANIZE_PERSONA } from './default-persona.js'

/** 从 PersonaStore 取人设；store 缺失/抛错/未命中一律返回 null，不影响默认人设 */
function lookupPersona(personaStore, id) {
  if (!personaStore || !id) return null
  try {
    return personaStore.get?.(id) || null
  } catch {
    return null
  }
}

/**
 * @param {object} cfg 伪人配置（agent.humanize）
 * @param {object} [opts]
 * @param {{get?: (id: string) => object|null}} [opts.personaStore] PersonaStore 或同形对象
 * @param {string} [opts.botNickname] Bot 昵称（全空时兜底）
 * @returns {{name: string, prompt: string, source: 'persona'|'custom'|'default'}}
 */
export function resolveHumanizePersona(cfg, { personaStore = null, botNickname = '' } = {}) {
  const persona = (cfg && cfg.persona) || {}
  const found = persona.fromPersonaId ? lookupPersona(personaStore, persona.fromPersonaId) : null
  const libraryPrompt = String(found?.systemPrompt || '').trim()
  const customPrompt = String(persona.prompt || '').trim()

  // 人设库命中时名称随库走（即使面板残留旧的 persona.name）；否则走原有身份解析链
  const libraryName = String(found?.name || '').trim()
  const name = (libraryPrompt && libraryName)
    ? libraryName
    : resolvePersonaIdentity(cfg, { botNickname }).name

  const prompt = libraryPrompt || customPrompt || DEFAULT_HUMANIZE_PERSONA.prompt
  const source = libraryPrompt ? 'persona' : customPrompt ? 'custom' : 'default'
  return { name, prompt, source }
}

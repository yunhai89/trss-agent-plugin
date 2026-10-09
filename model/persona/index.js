/**
 * 人设（persona）公共出口 —— 人设库 + 每用户激活绑定 + Agent 接入。
 *
 * 用法（apps 层）：
 *   import { PersonaStore, PersonaService } from '../model/persona/index.js'
 *   const store = new PersonaStore({ dir: path.join(yunzaiRoot, 'data/agents-plugin/personas') })
 *   const persona = new PersonaService({ store, kv })
 *   // 每轮对话解析激活人设：
 *   const { persona: p } = await persona.resolve(ctx.userId)
 *   await agent.run(input, { ctx, systemPrompt: p?.systemPrompt })
 *
 * 人设作为 Agent 的"身份层"替换默认 systemPrompt；工具/记忆/防护仍照常追加。
 */

import { PersonaStore, slugify, normalizePersona } from './store.js'
import { PersonaService } from './service.js'
import { BUILTIN_PERSONAS } from './defaults.js'
import { PersonaLore, normalizeLore, normalizeCanonical, normalizeSources, groundingText, assertSafeLore } from './lore.js'
import { PERSONA_COMPLETION_SYSTEM, buildCompletionInput, parseCompletionOutput, buildLoreDraft, formatDraftSummary } from './completion.js'

export {
  PersonaStore,
  PersonaService,
  PersonaLore,
  slugify,
  normalizePersona,
  normalizeLore,
  normalizeCanonical,
  normalizeSources,
  groundingText,
  assertSafeLore,
  BUILTIN_PERSONAS,
  PERSONA_COMPLETION_SYSTEM,
  buildCompletionInput,
  parseCompletionOutput,
  buildLoreDraft,
  formatDraftSummary,
}

/**
 * Anthropic 协议厂商预设。
 *
 * 关键差异（相对 OpenAI 库）：
 *  - 认证头默认 `x-api-key`（MiMo 用 `api-key`），通过 authHeader 配置
 *  - 需要 `anthropic-version` 头（默认 2023-06-01）
 *  - 可选 `anthropic-beta` 头
 *  - 端点为 /v1/messages
 *
 * DeepSeek / MiMo 同时提供 OpenAI 与 Anthropic 两套兼容端点；
 * 这里是它们的 Anthropic 协议入口（与 model/openai/presets.js 的 OpenAI 入口互补）。
 */

export const presets = {
  /** Anthropic 官方 */
  anthropic: {
    name: 'anthropic',
    baseURL: 'https://api.anthropic.com',
    version: '2023-06-01',
    authHeader: 'x-api-key',
  },

  /** DeepSeek（Anthropic 兼容端点，模型用 deepseek-v4-pro / deepseek-v4-flash） */
  deepseek: {
    name: 'deepseek',
    baseURL: 'https://api.deepseek.com/anthropic',
    version: '2023-06-01',
    authHeader: 'x-api-key',
  },

  /**
   * 小米 MiMo（Anthropic 兼容端点）
   * 按量付费：https://api.xiaomimimo.com/anthropic
   * Token Plan：https://token-plan-cn.xiaomimimo.com/anthropic（key 以 tp- 开头）
   * 注意：MiMo 的 Anthropic 协议认证头是 `api-key`（非 x-api-key）。
   */
  mimo: {
    name: 'mimo',
    baseURL: 'https://api.xiaomimimo.com/anthropic',
    version: '2023-06-01',
    authHeader: 'api-key',
  },

  /** MiniMax（Anthropic 兼容端点）。模型：MiniMax-M3。
   *  中国区：https://api.minimaxi.com/anthropic ；国际区：https://api.minimax.io/anthropic（config baseURL 覆盖）。
   *  认证 x-api-key 或 Bearer 均可（官方 SDK 用 x-api-key，本库默认 x-api-key）。
   *  baseURL 停在 /anthropic，client 自动拼 /v1/messages。
   *  thinking 走 content[] 的 thinking 块（原生分离，无 OpenAI 协议的 reasoning_split / <think> 问题）；
   *  建议配合 agent.thinking:{type:'adaptive'}。Token Plan 与按量 key 同一端点，仅 key 不同。 */
  minimax: {
    name: 'minimax',
    baseURL: 'https://api.minimaxi.com/anthropic',
    version: '2023-06-01',
    authHeader: 'x-api-key',
  },

  /** OpenCode Zen（Anthropic 兼容 /messages 端点：Claude / Qwen / MiniMax 系列）。
   *  ⚠️ baseURL 不带 /v1 —— Anthropic client 会自动拼 /v1/messages（带 /v1 会变双 /v1）。
   *  认证 x-api-key（官方文档：/messages 端点 x-api-key 或 Bearer 均可）。
   *  模型：claude-sonnet-4.5 / qwen3.7-max / minimax-m3 等。
   *  注意：DeepSeek/GLM/Kimi 走 OpenAI /chat/completions（用 model/openai/presets.js 的 opencode）。 */
  opencode: {
    name: 'opencode',
    baseURL: 'https://opencode.ai/zen',
    version: '2023-06-01',
    authHeader: 'x-api-key',
  },

  /** OpenCode Go 订阅制（Anthropic 兼容 /messages：MiniMax / Qwen）。
   *  baseURL: https://opencode.ai/zen/go（同样不带 /v1）；认证同 Zen。
   *  首月 $5 / 之后 $10 月，走额度（5h/周/月），零 Zen 余额也能用。 */
  'opencode-go': {
    name: 'opencode-go',
    baseURL: 'https://opencode.ai/zen/go',
    version: '2023-06-01',
    authHeader: 'x-api-key',
  },
}

export function getPreset(name) {
  const p = presets[name]
  if (!p) throw new Error(`未知 Anthropic 厂商预设：${name}`)
  return p
}

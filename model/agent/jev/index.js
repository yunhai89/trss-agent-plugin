/**
 * Jev（TypeSafe AI）判断模型接入 —— 公共出口。
 *
 * 独立于 provider 体系（Jev 非 OpenAI 兼容）：客户端原生 fetch、问题/阈值集中版本化、
 * 四个决策点（thinking/toolSelection/llmTool/terminalRisk）封装 + 置信度门控 + 无感回退。
 */
export { JevClient, JevError, createJevClient, DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_RETRIES, DEFAULT_RETRY, DEFAULT_CIRCUIT } from './client.js'
export {
  JEV_SPEC_VERSION, JEV_MODEL_DEFAULT, THRESHOLDS, resolveThresholds,
  THINKING_QUESTION, SHELL_RISK_QUESTION, REFLECT_QUESTION, toolActiveQuestion, noul, choice, score,
} from './spec.js'
export { decideThinkingWithJev, selectToolsWithJev, assessShellRiskWithJev, decideReflectWithJev, evaluateShellRisk } from './decisions.js'
export { makeJevTool, validateJevInput } from './tool.js'

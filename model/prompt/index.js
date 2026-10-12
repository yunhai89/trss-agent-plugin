/** Prompt 底层库 —— 公共出口 */
// 核心：构建器 + 变量注入 + 预优化模板
export {
  inject, SystemPromptBuilder, ToolPromptBuilder, assembleSystem, TEMPLATES, fromTemplate,
  EXECUTION_BIAS, SEARCH_VERIFICATION, SERVICE_DIRECTIVE, REFLECTION_DIRECTIVE, buildSkillsPromptSection, buildStickerPromptSection, buildToolCatalogSection, buildToolDiscoverySection, buildAgentSystemPrompt,
} from './library.js'
// 版本管理 + Fixtures + Eval
export { PromptTemplate, PromptRegistry, runFixtures, runEval, regressionGate } from './versioning.js'
// Evolution 桥接
export { evolveTemplate, evolveTemplates } from './evolution.js'

/**
 * groupworld —— 群聊小世界（社会记忆层）公共出口。
 *
 * 按群隔离、持续更新、带时间与证据、会遗忘、可局部检索的稀疏社会关系网络。
 * 设计文档：trss-agent-plugin-groupworld-design-v1.0.md。Phase 0+1+2。
 *
 * 核心红线（§3.1、§12）：事实/推断/主观分离；不推断敏感信息；低置信不进在线上下文；
 * 用户可查看/纠正/删除/退出；在线影响默认关（先观察再上线）。
 */

// 存储
export { getDb, initDb, closeDb, dao, isReady } from './db.js'
// 评分纯函数
export { interactionStrength, reciprocity, confidence, importance, retrievalScore, recencyFactor, estTokens, DEFAULT_MIN_ONLINE_CONFIDENCE } from './scoring.js'
// 语义层（P0：embedding 余弦 / BLOB 序列化 / 中文友好词面相似度）
export { cosine, toBlob, fromBlob, makeEmbedder, textSim, textFeatures, hybridSim } from './embedding.js'
// 组件
export { GroupWorldIngester, extractMentions, deriveMessageType } from './ingest.js'
export { ConversationSegmenter, isLowValue } from './segmenter.js'
export { EvidenceResolver } from './evidence.js'
export { WorldAnalyzer } from './analyzer.js'
export { WorldRetriever, TIER_LABEL } from './retriever.js'
export { WorldContextBuilder } from './context-builder.js'
export { WorldMaintenance } from './maintenance.js'
export { CommunityDetector } from './community.js'
// prompt 工具
export { ANALYZER_SYSTEM, buildAnalyzerPrompt, parseAnalyzerOutput, validateAnalyzerOutput, isSensitiveContent, buildSocialSceneBlock } from './prompts.js'
// 服务聚合（apps 层入口）
export { GroupWorldService } from './service.js'
// 配置
export { DEFAULT_GROUPWORLD_CONFIG, validateGroupWorldConfig, resolveGroupWorldConfig } from './default-config.js'

/**
 * selfstate —— 自我认知与情绪（GroupWorld × SelfState 联合层）公共出口。
 * 设计文档：trss-agent-plugin-groupworld-selfstate-design-v1.1.md。Phase 0-4 全量。
 *
 * 红线：情绪只是偏置；不影响功能/权限/工具结果；shadowMode 默认 true；不外显数值；
 * 跨群隔离；禁卖惨/跨用户扩散/功能报复；负状态 24h 上限恢复。
 */
export { DEFAULT_SELFSTATE_CONFIG, validateSelfStateConfig, resolveSelfStateConfig } from './default-config.js'
export { SelfCoreCompiler, personaVersion, DEFAULT_TEMPERAMENT } from './self-core.js'
export { SelfEventDetector, DETECT_KEYWORDS } from './detector.js'
export { AppraisalEngine } from './appraisal.js'
export { EmotionTransition, HALF_LIFE, EVENT_IMPULSES, decayIntensity } from './emotion.js'
export { ExpectationManager, classifyOutgoing } from './expectations.js'
export { ConcernManager } from './concerns.js'
export { SelfReflectionJob } from './reflection.js'
export { StateProjector } from './projector.js'
export { StateMaintenance } from './maintenance.js'
export { SelfStateService } from './service.js'

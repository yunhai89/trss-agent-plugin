/**
 * humanize —— 伪人模式（群聊环境参与者）公共出口。
 *
 * 在现有任务型 Agent 旁新增一条「持续旁听、低成本门控、工具化决策、独立表达、可中断发送」的流水线。
 * 两条模式共用 Provider/Persona/Recall/Memory/Sticker/Redis；会话、触发器、Planner、发送出口隔离。
 *
 * 红线：环境模式中，任何普通 assistant 文本都不能直接发送；只有 human_reply/human_react 才可对外发消息。
 */

export { normalizeYunzaiEvent, normalizeReplySource, isSelfEvent, collectSelfIds, fingerprintId, segmentsToText, textMentionsName } from './message-normalizer.js'
export { MessageBuffer } from './message-buffer.js'
export { HumanizeStore, newHolderId } from './store.js'
export { Trace, hashGroupId, redactForLog } from './trace.js'
export { evaluate as evaluateNecessity, pressureScore, presencePenalty, cooldownPenalty } from './necessity-scorer.js'
export { IdleBackoff } from './idle-backoff.js'
export { ACTION_TOOLS, ACTION_PRIORITY, TERMINAL_ACTIONS, SEND_ACTIONS, validateActionCall, pickSingleAction, isSilentAction, ACTION_LABEL } from './action-tools.js'
export { DEFAULT_BEHAVIOR_POLICY, resolveBehaviorPolicy, topicMatch, topicMatchScore, hitsAvoidTopic, withinReplyRate } from './behavior-policy.js'
export { HumanizeMemoryStore } from './memory-store.js'
export { MediaDescriber } from './vision-context.js'
export { resolveGrounding, formatGroundingBlock, whitelistViolations, windowNames } from './grounding.js'
export { fillTemplate, buildPlannerSystem, buildReplyerSystem, formatGroupContext, formatNecessityForPlanner, highlightTarget, buildHumanizePersonaBlock, MEMORY_CONSOLIDATE_SYSTEM, buildConsolidatePrompt } from './prompts.js'
export { ConversationSceneAnalyzer, ruleScene, extractSceneFeatures, validateScene, participantsFromGrounding, formatSceneBlock, sceneLengthHint, SCENE_TYPES, SPEECH_ACTS, TONES, PHASES } from './scene.js'
export { DEFAULT_STYLE_EXAMPLES, pickStyleExamples, formatStyleExamples } from './style-examples.js'
export { GroupRuntime } from './group-runtime.js'
export { TurnScheduler } from './turn-scheduler.js'
export { RuntimeManager } from './runtime-manager.js'
export { HumanizePlanner } from './planner.js'
export { HumanizeReplyer, textSimilarity } from './replyer.js'
export { HumanizeReplyComposer, splitSegments, typingDelayMs } from './reply-composer.js'

/** 默认人类化配置（指南 §15）。默认全关，需显式白名单。 */
export { DEFAULT_HUMANIZE_CONFIG } from './default-config.js'
/** 配置校验（buildRuntime/应用启动时调用，硬约束）。 */
export { validateHumanizeConfig, resolveHumanizeConfig, resolvePersonaIdentity } from './default-config.js'
/** 内置默认伪人人设（persona 留空时启用，刻意去 AI 味、尊重看人）。 */
export { DEFAULT_HUMANIZE_PERSONA } from './default-persona.js'

/**
 * 工具版本状态机（开发文档 §7）。
 *
 * QQ 单 bot 无真实流量可分流 → 砍 shadow/canary 灰度，用「回放测试集 + 主人审批」替代：
 *   draft     模型生成的原始候选
 *     → verified    静态(AST)+行为(沙箱测试/回放)验证全过
 *     → rejected    验证失败且不可修复 / 危险一票否决
 *   verified  → stable      主人审批晋升（#采纳工具，直接进生产）
 *   stable    → quarantined 回归/安全告警（隔离）
 *            → deprecated  被替代或低价值（人工）
 *
 * 注：历史上的 approved 中间态从未被任何链路进入（引擎自动 draft→verified，
 *     #采纳直接 verified→stable），已删除——审批动作即晋升动作。
 *
 * 修订永远创建新版本（parent_version_id 成链），不在原版本上改状态回 draft。
 */

const STATES = new Set(['draft', 'rejected', 'verified', 'stable', 'quarantined', 'deprecated'])

const TRANSITIONS = {
  draft: ['verified', 'rejected'],
  rejected: [],
  verified: ['stable', 'rejected'],
  stable: ['quarantined', 'deprecated'],
  quarantined: ['deprecated'],
  deprecated: [],
}

export function isValidState(s) { return STATES.has(s) }

export function canTransition(from, to) {
  if (!STATES.has(from) || !STATES.has(to)) return false
  return TRANSITIONS[from]?.includes(to) === true
}

/** 终态（不可再转移；修复须新建版本走 draft） */
export function isTerminal(s) { return s === 'rejected' || s === 'deprecated' }

/** 能否服务真实任务（注入 ToolRegistry 供 agent 调用） */
export function canServe(s) { return s === 'stable' }

/** 需人工审批才能进入（写/消息/删除类第一版禁自动生成，仅 none/read 可生成但仍需审批晋升） */
export function needsApproval(to) { return to === 'stable' }

export const STATE = STATES

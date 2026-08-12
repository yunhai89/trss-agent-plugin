/**
 * MemoryAdapter —— 群公开记忆适配器（指南 §14.2）。
 *
 * 核心红线：user_private 绝对不可注入群聊。隐私边界在**数据访问层**实现，不只靠 Prompt：
 * 本适配器只暴露 group_public 读取，物理上不提供查询用户私有 scope 的方法。
 *
 * 记忆域：
 *  - group_public：群规/公开项目/群内公开称呼（可注入）
 *  - group_user_public：某成员公开声明的偏好（可，需来源/置信）
 *  - user_private：私聊偏好/隐私（**绝对不可**）—— 本适配器不接触
 *  - bot_persona：机器人自身设定（可）
 *
 * 实现：复用 RecallStore（按 scopeUserId 键），group_public 用专用 scope key（hgp_<gid>），
 * 与用户私有 scope（u_<uid> / g<gid>_u<uid>）物理分键。读接口只查 group_public scope。
 */

/** 群公开记忆 scope key（与用户私有 scope 物理隔离）。 */
export function groupPublicScope(groupId) {
  return `hgp_${groupId}`
}

export class MemoryAdapter {
  /**
   * @param {object} opts { recall?, memory?, kv? }
   *   recall = getRuntime().recall（RecallStore，retrieve/query）
   *   memory = getRuntime().memory（MemoryStore，可选）
   *   kv = getRuntime().kv（群公开人物摘要存储）
   */
  constructor({ recall = null, memory = null, kv = null } = {}) {
    this.recall = recall
    this.memory = memory
    this.kv = kv
  }

  /**
   * 检索群公开记忆（仅 group_public）。绝不查询用户私有 scope。
   * @param {string} groupId
   * @param {string} query
   * @param {number} topK
   * @returns {Promise<Array>} 记忆条目数组
   */
  async retrieveGroupPublic(groupId, query, topK = 5) {
    if (!this.recall || !groupId) return []
    try {
      // 数据层强制：只查 group_public scope，不接受外部 scope 参数
      return await this.recall.retrieve(query, groupPublicScope(groupId), topK)
    } catch {
      return []
    }
  }

  /**
   * 写入群公开记忆（从环境回复中抽取的群公开事实；非用户私有）。
   * Phase 4 表达/风格学习在此扩展；MVP 可不自动写。
   */
  async writeGroupPublic(groupId, text, llm) {
    if (!this.recall || !groupId) return
    try {
      if (typeof this.recall.extractAndWrite === 'function') {
        // extractAndWrite(snapshot, scopeUserId, {llm})；snapshot 为内部消息数组
        await this.recall.extractAndWrite([{ role: 'assistant', content: text }], groupPublicScope(groupId), { llm })
      }
    } catch { /* noop */ }
  }

  /**
   * 取群内某成员的公开摘要（group_user_public；需来源/置信，可选）。
   * 与用户私有严格分离：只读 group 公开 KV 键，不读用户私有记忆文件。
   */
  async getGroupUserPublic(groupId, userId) {
    if (!this.kv || !groupId || !userId) return null
    try {
      return await this.kv.get(`humanize:profile:${groupId}:${userId}`)
    } catch { return null }
  }

  async setGroupUserPublic(groupId, userId, profile) {
    if (!this.kv || !groupId || !userId) return
    try { await this.kv.set(`humanize:profile:${groupId}:${userId}`, profile || {}) } catch { /* noop */ }
  }

  /**
   * 显式 scope 断言：供上层自查。private 永远抛错（防误用）。
   * @param {'group_public'|'group_user_public'|'bot_persona'} scope
   */
  assertPublicScope(scope) {
    const ALLOWED = new Set(['group_public', 'group_user_public', 'bot_persona'])
    if (!ALLOWED.has(scope)) {
      throw new Error(`隐私边界违规：humanize 不允许访问 scope=${scope}（user_private 绝对不可注入群聊）`)
    }
    return true
  }
}

/** 安全格式化群公开记忆为 Prompt 片段。 */
export function formatPublicMemories(memories) {
  if (!Array.isArray(memories) || !memories.length) return ''
  return memories.slice(0, 5).map((m) => `- ${typeof m === 'string' ? m : (m?.text || m?.content || JSON.stringify(m))}`).join('\n')
}

/**
 * PersonaService —— 人设的"当前选中"绑定（每用户一份），对接 Agent。
 *
 * 绑定存 kv（复用 session/recall 的 memoryKv/redisKv），key: persona:active:<userId>。
 * resolve(userId) 返回当前生效人设（null 表示用 Agent 默认 systemPrompt）。
 * 库解耦：store + kv 注入，不依赖插件 Config/Log。
 */

export class PersonaService {
  constructor({ store, kv, prefix = 'persona:active' } = {}) {
    if (!store) throw new Error('PersonaService 需要 store')
    if (!kv) throw new Error('PersonaService 需要 kv')
    this.store = store
    this.kv = kv
    this.prefix = prefix
  }

  _key(userId) {
    return `${this.prefix}:${userId}`
  }

  /** 当前激活的人设 id（未设置返回 null） */
  async getActiveId(userId) {
    const v = await this.kv.get(this._key(userId))
    return v ? String(v) : null
  }

  /** 设置激活人设（按 id 或名称），返回该人设；不存在则报错 */
  async setActive(userId, idOrName) {
    const p = this.store.get(idOrName)
    if (!p) throw new Error(`未找到人设「${idOrName}」`)
    await this.kv.set(this._key(userId), p.id)
    return p
  }

  /** 重置为默认（清除绑定） */
  async resetActive(userId) {
    await this.kv.del(this._key(userId))
  }

  /** 按 id 或名称（模糊）取人设 */
  resolveRef(input) {
    const s = String(input ?? '').trim()
    if (!s) return null
    // 数字 → #人设列表序号（1-based），与 #人设 切换一致；否则按 id/名称
    if (/^\d+$/.test(s)) {
      const list = this.store.list()
      const idx = Number(s) - 1
      return (idx >= 0 && idx < list.length) ? list[idx] : null
    }
    return this.store.get(s)
  }

  /**
   * 解析当前生效人设。
   * @returns {Promise<{ persona: Persona|null, activeId: string|null, isDefault: boolean }>}
   *   persona=null 表示用 Agent 默认 systemPrompt
   */
  async resolve(userId) {
    const activeId = await this.getActiveId(userId)
    if (!activeId) return { persona: null, activeId: null, isDefault: true }
    const persona = this.store.get(activeId)
    // 绑定的人设被删除 → 自动回落默认
    if (!persona) {
      await this.kv.del(this._key(userId))
      return { persona: null, activeId: null, isDefault: true }
    }
    return { persona, activeId, isDefault: false }
  }
}

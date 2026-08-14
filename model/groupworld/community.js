/**
 * CommunityDetector —— 小圈子识别（设计文档 §5.8、§6.5）。
 *
 * 从 gw_edges（近 activeEdgeDays、interaction_strength>0）建内存图投影，跑**标签传播**（label propagation）
 * 划分社区。文档 §6.5 允许 "Leiden 等" 算法；MVP 用标签传播：实现简单、纯 JS、零依赖、对稀疏图足够，
 * 只用于辅助检索/理解群结构，不直接把结论说给群友听（§5.8）。algorithm='label_prop_v1'。
 *
 * 小圈子是**阶段性统计结果，不是永久身份**（§5.8）：每次产出新版本行，旧版本自然被 retriever 取最新而淘汰；
 * maintenance 每周清理过期版本。
 */
import Log from '../../utils/Log.js'

const ALGO = 'label_prop_v1'
const ALGO_VER = '1'

export class CommunityDetector {
  /**
   * @param {object} opts { dao, cfg:()=>object, trace? }
   */
  constructor({ dao, cfg, trace = null }) {
    if (!dao) throw new Error('CommunityDetector 需要 dao')
    this.dao = dao
    this._cfgFn = typeof cfg === 'function' ? cfg : () => cfg || {}
    this.trace = trace
  }

  /** 对一个群跑社区发现，写入 gw_communities。返回 { communities, written }。 */
  async detect(groupId, now = Date.now()) {
    const c = this._cfgFn()
    const g = c.graph || {}
    const activeDays = Number(g.activeEdgeDays) || 90
    const cutoff = now - activeDays * 86400000
    const minStrength = 0.05

    // 建无向加权邻接（双向边权重合并）
    const rows = await this.dao.all(
      'SELECT from_user_id,to_user_id,interaction_strength FROM gw_edges WHERE group_id=? AND interaction_strength>=? AND last_interacted_at>=?',
      [groupId, minStrength, cutoff],
    )
    const adj = new Map() // userId -> Map<neighbor, weight>
    const addW = (a, b, w) => {
      if (!adj.has(a)) adj.set(a, new Map())
      adj.get(a).set(b, (adj.get(a).get(b) || 0) + w)
    }
    for (const e of rows) {
      const w = Number(e.interaction_strength) || 0
      addW(e.from_user_id, e.to_user_id, w)
      addW(e.to_user_id, e.from_user_id, w)
    }
    const nodes = [...adj.keys()]
    if (nodes.length < 3) return { communities: [], written: 0 } // 太少不值得分

    // 标签传播
    const labels = new Map(nodes.map((n) => [n, n]))
    let changed = true; let iter = 0
    const maxIter = Math.max(10, Math.min(30, Math.round(Math.log2(nodes.length + 2) * 6)))
    // 异步随机序（节点顺序固定，避免 Math.random 以保证可复现）
    while (changed && iter < maxIter) {
      changed = false; iter++
      for (let i = 0; i < nodes.length; i++) {
        // 简单轮转起始点，模拟无偏遍历
        const n = nodes[(i + iter) % nodes.length]
        const neigh = adj.get(n)
        if (!neigh || !neigh.size) continue
        const tally = new Map()
        for (const [nb, w] of neigh) tally.set(labels.get(nb), (tally.get(labels.get(nb)) || 0) + w)
        // 选权重最大的标签；平局保留当前
        let best = labels.get(n); let bestW = -1
        for (const [lab, w] of tally) {
          if (w > bestW || (w === bestW && lab === labels.get(n))) { bestW = w; best = lab }
        }
        if (best !== labels.get(n)) { labels.set(n, best); changed = true }
      }
    }

    // 聚合为社区
    const groups = new Map()
    for (const n of nodes) {
      const lab = labels.get(n)
      if (!groups.has(lab)) groups.set(lab, [])
      groups.get(lab).push(n)
    }

    // 度（加权）→ 核心成员
    const degree = new Map()
    for (const [n, neigh] of adj) {
      let d = 0; for (const w of neigh.values()) d += w
      degree.set(n, d)
    }

    const minSize = Math.max(2, Number(g.minCommunitySize) || 3)
    const written = []
    for (const [, members] of groups) {
      if (members.length < minSize) continue
      const sorted = members.slice().sort((a, b) => (degree.get(b) || 0) - (degree.get(a) || 0))
      const core = sorted.slice(0, Math.min(3, members.length))
      const tagSet = new Set()
      // 主题标签：从核心成员的 interest 特征取
      for (const uid of core) {
        const ts = await this.dao.all("SELECT trait_value FROM gw_traits WHERE group_id=? AND user_id=? AND trait_type='interest' AND status='active' ORDER BY confidence DESC LIMIT 2", [groupId, uid])
        for (const t of ts) tagSet.add(String(t.trait_value).slice(0, 12))
        if (tagSet.size >= 3) break
      }
      const summary = `${members.length}人活跃互动圈（核心：${(await this._names(groupId, core)).join('、')}）`
      const memberIds = JSON.stringify(members)
      const coreIds = JSON.stringify(core)
      const tags = JSON.stringify([...tagSet].slice(0, 3))
      const res = await this.dao.run(
        `INSERT INTO gw_communities(group_id,algorithm,algorithm_ver,member_ids,core_member_ids,topic_tags,summary,confidence,valid_from,valid_until,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [groupId, ALGO, ALGO_VER, memberIds, coreIds, tags, summary, 0.6, now, now + 7 * 86400000, now],
      )
      written.push({ id: res?.lastID ?? null, size: members.length, core })
    }

    // 清理 14 天前的旧版本
    try { await this.dao.run('DELETE FROM gw_communities WHERE group_id=? AND created_at<?', [groupId, now - 14 * 86400000]) } catch { /* noop */ }

    this.trace?.record?.('gw_community', { groupId, nodes: nodes.length, communities: written.length })
    Log.mark('[community]', `群${groupId} 节点${nodes.length} → 圈子${written.length}（${ALGO}）`)
    return { communities: written, written: written.length }
  }

  async _names(groupId, uids) {
    const out = []
    for (const uid of uids) {
      const r = await this.dao.get('SELECT current_nickname FROM gw_member_profiles WHERE group_id=? AND user_id=?', [groupId, uid])
      out.push(r?.current_nickname || uid)
    }
    return out
  }
}

export { ALGO, ALGO_VER }

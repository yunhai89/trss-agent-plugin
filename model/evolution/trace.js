/**
 * 轨迹采集 —— 把真实 Agent 执行落盘为 JSONL，供进化引擎作为评估数据集（对应 hermes --eval-source sessiondb）。
 */

import fs from 'node:fs'
import path from 'node:path'

export class TraceStore {
  constructor({ dir, file = 'traces.jsonl' } = {}) {
    if (!dir) throw new Error('TraceStore 需要 dir')
    this.dir = dir
    this.file = path.join(dir, file)
    fs.mkdirSync(dir, { recursive: true })
    if (!fs.existsSync(this.file)) fs.writeFileSync(this.file, '')
  }

  /** 追加一条轨迹（自动加 ts） */
  record(trace) {
    const line = JSON.stringify({ ts: Date.now(), ...trace })
    fs.appendFileSync(this.file, line + '\n')
    return trace
  }

  /** 读取全部轨迹 */
  all() {
    try {
      const text = fs.readFileSync(this.file, 'utf8')
      return text
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l)
          } catch {
            return null
          }
        })
        .filter(Boolean)
    } catch {
      return []
    }
  }

  /** 随机采样 n 条（rng 可注入，便于确定性测试） */
  sample(n = 10, rng = Math.random) {
    const all = this.all()
    if (all.length <= n) return all
    const idx = [...all.keys()]
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1))
      ;[idx[i], idx[j]] = [idx[j], idx[i]]
    }
    return idx.slice(0, n).map((i) => all[i])
  }

  clear() {
    fs.writeFileSync(this.file, '')
  }

  get size() {
    return this.all().length
  }
}

/**
 * 包装一个 Agent：每次 run 后把执行轨迹写入 TraceStore。
 * target 快照标注这条轨迹属于哪个进化对象。
 * scope/scopeId 必须与 SelfReviewer 的读取口径同源（review.js：`t.scope === scopeUserId`）——
 * 生产者不写 scope 时，自评审的「近期对话摘要」恒为「（暂无）」。
 * 构造参数给默认值，run 的 opts 可逐次覆盖（与生产侧手写 record({ scope: ctx.scopeUserId }) 一致）。
 */
export class TraceCollector {
  constructor({ agent, store, target, scope = null, scopeId = null }) {
    this.agent = agent
    this.store = store
    this.target = target || null
    this.scope = scope
    this.scopeId = scopeId
  }

  async run(input, opts = {}) {
    const result = await this.agent.run(input, opts)
    const trace = {
      scope: opts.scope ?? this.scope ?? null,
      scopeId: opts.scopeId ?? this.scopeId ?? null,
      target: this.target,
      input: typeof input === 'string' ? input : input?.content ?? input,
      output: result.content,
      messages: result.messages,
      turns: result.turns,
      usage: result.usage,
      stopReason: result.stopReason,
      taskId: result.taskId,
    }
    this.store?.record(trace)
    return { ...result, trace }
  }
}

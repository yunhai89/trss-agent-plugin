// apps/agent.js 桩——E2E harness 用。只提供 getRuntime()（apps/humanize.js 与 apps/groupworld.js 的唯一依赖）。
// RT.provider 由驱动脚本按"当前调用方"动态应答（planner/replyer/appraisal/analyzer 靠 system prompt 区分）。
const TMP = process.env.E2E_TMP || '/tmp/e2e-harness'

function memKV() {
  const m = new Map()
  return {
    async get(k) { return m.has(k) ? m.get(k) : null },
    async set(k, v) { m.set(k, v) },
    async del(k) { m.delete(k) },
  }
}

export const RT = {
  provider: null, // 驱动脚本注入
  vision: null, // 驱动脚本按需注入（伪人看图 E2E）
  kv: memKV(),
  recall: { retrieve: async () => '', extractAndWrite: async () => {} },
  memory: null,
  sticker: null,
  tools: null,
  botId: '2721779039',
  persona: { store: { get: () => null } },
}

export async function getRuntime() { return RT }

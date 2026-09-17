/**
 * Stagehand 浏览器自动化 —— 工具包公共出口。
 *
 * makeStagehand({ cfg, agent }) → { pack, sessionMgr }
 *   pack：defineToolPack({name:'stagehand', tools:[goto/observe/extract/act]})，子工具自动加 stagehand__ 前缀。
 *   sessionMgr：SessionManager（closeAll 交 buildRuntime 在 runtime 失效时调）。
 *
 * RBAC：全部 category:'system'（框架 master 限定；与 terminal 自包含主人互不相关）。
 * act 是写动作（点击/输入/提交）→ meta.alwaysConfirm + interactive（每条 #确认 + 串行）。
 * goto/observe/extract 为读/导航，master 限定即门槛。
 *
 * model 决策：
 *   - cfg.modelName 非空 → Stagehand 原生模型（{modelName, apiKey?}；云模式空 apiKey 走 Model Gateway）
 *   - 否则插件 protocol 为 openai(或未指定) → 复用 provider（{generate: makeGenerate(...)}，仅 OpenAI 兼容）
 *   - 否则（anthropic 且无 modelName）→ 不传 model（云=Gateway 自动；本地=Stagehand 报错，提示配 modelName）
 */
import { defineToolPack, defineTool, param, ok, fail } from '../toolkit/index.js'
import { SessionManager } from './session.js'
import { makeGenerate } from './llm.js'
import { assertUrlAllowed } from './guard.js'

export function makeStagehand(opt = {}) {
  const cfg = opt.cfg || {}
  const agent = opt.agent || {}
  // 权限：'all' 开放给全部成员（goto/observe/extract 直接可用，act 仍每条 #确认）；'master' 仅主人（category=system）
  const category = String(cfg.permission || 'master').toLowerCase() === 'all' ? 'query' : 'system'
  // 配额（防成员滥用/成本失控）：每会员每分钟调用数 + 每日调用数
  const maxPerMinute = Math.max(1, Number(cfg.maxCallsPerMinute) || 10)
  const maxPerDay = Math.max(1, Number(cfg.maxCallsPerDay) || 200)
  const _rl = new Map() // scope -> { mStart, m, dStart, d }
  function quotaError(scope) {
    const now = Date.now()
    const r = _rl.get(scope) || { mStart: now, m: 0, dStart: now, d: 0 }
    if (now - r.mStart > 60000) { r.mStart = now; r.m = 0 }
    if (now - r.dStart > 86400000) { r.dStart = now; r.d = 0 }
    r.m++; r.d++
    _rl.set(scope, r)
    if (r.m > maxPerMinute) return `浏览器操作过于频繁（上限 ${maxPerMinute} 次/分钟），请稍后再试`
    if (r.d > maxPerDay) return `今日浏览器操作已达上限（${maxPerDay} 次），请明天再试`
    return null
  }
  const blockedHosts = Array.isArray(cfg.blockedHosts) ? cfg.blockedHosts : []

  const buildModel = () => {
    if (cfg.modelName) {
      return cfg.modelApiKey ? { modelName: cfg.modelName, apiKey: cfg.modelApiKey } : { modelName: cfg.modelName }
    }
    if (agent.protocol === 'openai' || agent.protocol == null) {
      return { generate: makeGenerate({ apiKey: agent.apiKey, baseURL: agent.baseURL, model: agent.model }) }
    }
    return undefined
  }

  const sessionMgr = new SessionManager({ cfg, buildModel })

  const scopeOf = (ctx) => ctx?.scopeUserId || ctx?.userId || 'default'

  const tools = [
    defineTool({
      name: 'goto',
      category,
      description: '用浏览器打开指定 URL（导航）。是 stagehand 多步任务的起点；页面会跨调用保持，供后续 stagehand__act/extract/observe 在同一页面上操作。返回页面 URL 与标题。仅允许公网 http/https，本地/内网/元数据地址会被拒绝。',
      meta: { summary: '浏览器打开 URL' },
      parameters: param.object({ url: param.str('要打开的网页 URL（含 http(s)://）') }, ['url']),
      async execute(p, ctx) {
        const scope = scopeOf(ctx)
        const over = quotaError(scope)
        if (over) return fail(over)
        // 出口目标限制：防 SSRF 打内网（本地浏览器跑在宿主进程）
        const verdict = await assertUrlAllowed(p.url, { blockedHosts })
        if (!verdict.ok) return fail(`导航被拒绝：${verdict.reason}`)
        try {
          const { page } = await sessionMgr.acquire(scope)
          await page.goto(verdict.url)
          let title = ''
          try { title = await page.title() } catch { /* noop */ }
          // 重定向兜底：最终落地地址同样校验
          let finalUrl = ''
          try { finalUrl = await page.url() } catch { try { finalUrl = await page.evaluate(() => globalThis.location.href) } catch { /* noop */ } }
          if (finalUrl) {
            const v2 = await assertUrlAllowed(finalUrl, { blockedHosts })
            if (!v2.ok) { try { await page.goto('about:blank') } catch { /* noop */ } ; return fail(`导航被重定向到受限地址，已终止：${v2.reason}`) }
          }
          return ok({ url: finalUrl || verdict.url, title })
        } catch (e) { return fail(`导航失败：${e?.message || e}`) }
      },
    }),
    defineTool({
      name: 'observe',
      category,
      description: '观察当前页面，返回可交互元素列表（按钮/链接/输入框等）。用自然语言描述想找什么，如"登录相关的可点击元素"。只读，不改页面。需先用 stagehand__goto 打开页面。',
      meta: { summary: '观察页面可交互元素', resultCap: 6000 },
      parameters: param.object({ instruction: param.str('想观察什么（自然语言，如"导航栏可点击项"）；留空=列出全部可交互元素') }, []),
      async execute(p, ctx) {
        const over = quotaError(scopeOf(ctx)); if (over) return fail(over)
        const s = sessionMgr.get(scopeOf(ctx))
        if (!s) return fail('当前无打开的页面，请先调用 stagehand__goto')
        try {
          const r = await s.stagehand.observe(p.instruction || '列出页面上可交互的元素')
          return ok(r?.data ?? r)
        } catch (e) { return fail(`observe 失败：${e?.message || e}`) }
      },
    }),
    defineTool({
      name: 'extract',
      category,
      description: '从当前页面抽取结构化数据（读取动态渲染、JS 执行后的内容）。用自然语言说"抽什么"+ 用 JSON Schema 描述结构。如抽商品标题/价格/表格行。需先 stagehand__goto 打开页面。',
      meta: { summary: '抽取页面结构化数据', resultCap: 8000 },
      parameters: param.object({
        instruction: param.str('要抽取什么（自然语言，如"每个商品的名字和价格"）'),
        schema: param.str('JSON Schema 描述结构，如 {"type":"object","properties":{"title":{"type":"string"},"price":{"type":"string"}},"required":["title"]}'),
      }, ['instruction', 'schema']),
      async execute(p, ctx) {
        const over = quotaError(scopeOf(ctx)); if (over) return fail(over)
        const s = sessionMgr.get(scopeOf(ctx))
        if (!s) return fail('当前无打开的页面，请先调用 stagehand__goto')
        let schemaObj
        try { schemaObj = typeof p.schema === 'string' ? JSON.parse(p.schema) : p.schema } catch { return fail('schema 不是合法 JSON') }
        let zod, zodSchema
        try { zod = (await import('zod')).z } catch (e) { return fail(`zod 未安装（stagehand extract 需要）：${e?.message || e}`) }
        try { zodSchema = jsonSchemaToZod(zod, schemaObj) } catch (e) { return fail(`schema 转 zod 失败：${e?.message || e}`) }
        try {
          const r = await s.stagehand.extract(p.instruction, zodSchema)
          return ok(r?.data ?? r)
        } catch (e) { return fail(`extract 失败：${e?.message || e}`) }
      },
    }),
    defineTool({
      name: 'act',
      category,
      description: '在当前页面上执行动作（点击/输入/选择/提交等）。用自然语言描述，如"在搜索框输入 deepseek 并回车"或"点击登录按钮"。写动作，每次需主人 #确认。需先 stagehand__goto 打开页面。',
      meta: { summary: '执行页面动作(点击/输入/提交)', alwaysConfirm: true, interactive: true },
      parameters: param.object({ instruction: param.str('要执行的动作（自然语言）') }, ['instruction']),
      async execute(p, ctx) {
        const over = quotaError(scopeOf(ctx)); if (over) return fail(over)
        const s = sessionMgr.get(scopeOf(ctx))
        if (!s) return fail('当前无打开的页面，请先调用 stagehand__goto')
        try {
          const r = await s.stagehand.act(p.instruction)
          return ok(r?.data ?? r ?? { done: true })
        } catch (e) { return fail(`act 失败：${e?.message || e}`) }
      },
    }),
  ]

  const pack = defineToolPack({ name: 'stagehand', description: 'Stagehand 浏览器自动化（goto/observe/extract/act）', tools })
  return { pack, sessionMgr }
}

/**
 * JSON Schema → zod schema（Stagehand.extract 接受 zod）。
 * @param {object} z zod 实例（extract 工具内 await import('zod') 取得）
 * @param {object} schema JSON Schema 描述
 * 支持 object/array/string/number/integer/boolean 与 required；嵌套递归；未知 type → z.unknown()。
 */
export function jsonSchemaToZod(z, schema, seen = new Map()) {
  if (!z || schema == null || typeof schema !== 'object') return z ? z.unknown() : undefined
  if (seen.has(schema)) return seen.get(schema)
  switch (schema.type) {
    case 'string': return z.string()
    case 'number':
    case 'integer': return z.number()
    case 'boolean': return z.boolean()
    case 'array': return z.array(jsonSchemaToZod(z, schema.items, seen) || z.unknown())
    case 'object': {
      const props = schema.properties || {}
      const required = new Set(Array.isArray(schema.required) ? schema.required : [])
      // 先占位防循环引用栈溢出（模型生成的抽取 schema 实际不自引用，占位仅兜底）
      seen.set(schema, z.unknown())
      const shape = {}
      for (const [k, v] of Object.entries(props)) {
        const child = jsonSchemaToZod(z, v, seen) || z.unknown()
        shape[k] = required.has(k) ? child : child.optional()
      }
      const obj = z.object(shape)
      seen.set(schema, obj)
      return obj
    }
    default: return z.unknown()
  }
}


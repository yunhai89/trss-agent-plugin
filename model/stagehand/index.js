/**
 * Stagehand 浏览器自动化 —— 工具包公共出口。
 *
 * makeStagehand({ cfg, agent, fetch }) → { pack, sessionMgr }
 *   pack：defineToolPack({name:'stagehand', tools:[goto/observe/extract/act]})，子工具自动加 stagehand__ 前缀。
 *   sessionMgr：SessionManager（closeAll 交 buildRuntime 在 runtime 失效时调）。
 *
 * RBAC：permission=master → category:'system'（框架 master 限定）；permission=all → category:'query'。
 * act 是写动作（点击/输入/提交）→ meta.alwaysConfirm + interactive（每条 #确认 + 串行）。
 *
 * 身份隔离（可靠性审计）：
 *   sessionKey = 机器人 | 群/私聊 | 真实操作者 | 对话；限流绑定「机器人 + 真实操作者」，
 *   切换对话不能重置配额；缺少机器人/用户标识直接拒绝（不启动浏览器）。
 *
 * model 决策：
 *   - cfg.modelName 非空 → Stagehand 原生模型（{modelName, apiKey?}；云模式空 apiKey 走 Model Gateway）
 *   - 否则插件 protocol 为 openai(或未指定) → 复用 provider（{generate: makeGenerate(...)}，仅 OpenAI 兼容），
 *     复用主 provider 代理 fetch，并把会话操作级 signal 贯穿到 LLM 请求。
 *   - 否则（anthropic 且无 modelName）→ 不传 model（云=Gateway 自动；本地=Stagehand 报错，提示配 modelName）
 *
 * 返回契约（同步工具描述与 README）：
 *   - goto：{ok:true, url, title, status?}
 *   - observe/extract：{ok:true, data, metadata?}
 *   - act：仅 SDK 明确返回 data.success === true 才成功；完整结果在 data，失败返回明确错误。
 */
import { defineToolPack, defineTool, param, ok, fail } from '../toolkit/index.js'
import { SessionManager } from './session.js'
import { makeGenerate } from './llm.js'
import { assertUrlAllowed } from './guard.js'
import { jsonSchemaToZod } from './schema.js'

export { jsonSchemaToZod }

export function makeStagehand(opt = {}) {
  const cfg = opt.cfg || {}
  const agent = opt.agent || {}
  const proxyFetch = typeof opt.fetch === 'function' ? opt.fetch : null
  // 权限：'all' 开放给全部成员（goto/observe/extract 直接可用，act 仍每条 #确认）；'master' 仅主人（category=system）
  const category = String(cfg.permission || 'master').toLowerCase() === 'all' ? 'query' : 'system'
  // 配额（防成员滥用/成本失控）：每操作者每分钟调用数 + 每日调用数
  const maxPerMinute = Math.max(1, Number(cfg.maxCallsPerMinute) || 10)
  const maxPerDay = Math.max(1, Number(cfg.maxCallsPerDay) || 200)
  const _rl = new Map() // operator(bot|user) -> { mStart, m, dStart, d }
  function quotaError(operator) {
    const now = Date.now()
    const r = _rl.get(operator) || { mStart: now, m: 0, dStart: now, d: 0 }
    if (now - r.mStart > 60000) { r.mStart = now; r.m = 0 }
    if (now - r.dStart > 86400000) { r.dStart = now; r.d = 0 }
    r.m++; r.d++
    _rl.set(operator, r)
    if (r.m > maxPerMinute) return `浏览器操作过于频繁（上限 ${maxPerMinute} 次/分钟），请稍后再试`
    if (r.d > maxPerDay) return `今日浏览器操作已达上限（${maxPerDay} 次），请明天再试`
    return null
  }
  const blockedHosts = Array.isArray(cfg.blockedHosts) ? cfg.blockedHosts : []
  const opTimeoutMs = Number(cfg.opTimeoutMs) || undefined

  const buildModel = (key) => {
    if (cfg.modelName) {
      return cfg.modelApiKey ? { modelName: cfg.modelName, apiKey: cfg.modelApiKey } : { modelName: cfg.modelName }
    }
    if (agent.protocol === 'openai' || agent.protocol == null) {
      return {
        generate: makeGenerate({
          apiKey: agent.apiKey, baseURL: agent.baseURL, model: agent.model,
          fetch: proxyFetch,
          timeoutMs: Number(cfg.llmTimeoutMs) || undefined,
          getSignal: () => sessionMgr.signalOf(key),
        }),
      }
    }
    return undefined
  }

  const sessionMgr = opt.sessionMgr || new SessionManager({ cfg, buildModel, opTimeoutMs, launcher: opt.launcher || null, installPolicy: opt.installPolicy || null })

  /** 由 ctx 解析身份：{key(sessionKey), operator(限流键)}；缺少机器人/用户标识返回 null。 */
  function identityOf(ctx) {
    if (!ctx || typeof ctx !== 'object') return null
    const userId = String(ctx.userId ?? ctx.e?.user_id ?? '').trim()
    const botId = String(ctx.selfId ?? ctx.botId ?? ctx.bot?.uin ?? ctx.e?.self_id ?? '').trim()
    if (!userId || !botId) return null
    const gid = ctx.groupId != null && String(ctx.groupId) ? String(ctx.groupId) : null
    const conv = String(ctx.conversationId || '0')
    const scope = gid ? `g${gid}` : `u${userId}`
    return { key: `${botId}|${scope}|${userId}|${conv}`, operator: `${botId}|${userId}` }
  }

  const needIdentity = () => fail('无法识别操作者身份（缺少机器人/用户标识），已拒绝浏览器操作', { errorClass: 'identity_missing' })

  const tools = [
    defineTool({
      name: 'goto',
      category,
      description: '用浏览器打开指定 URL（导航）。是 stagehand 多步任务的起点；页面会跨调用保持，供后续 stagehand__act/extract/observe 在同一页面上操作。成功返回 {ok:true, url, title, status?}（并附 data 别名；请读取 result.url/result.title 或 result.data）。仅允许公网 http/https，本地/内网/元数据地址会被拒绝。',
      meta: { summary: '浏览器打开 URL' },
      parameters: param.object({ url: param.str('要打开的网页 URL（含 http(s)://）') }, ['url']),
      async execute(p, ctx) {
        const id = identityOf(ctx)
        if (!id) return needIdentity()
        const over = quotaError(id.operator)
        if (over) return fail(over, { errorClass: 'rate_limited' })
        const signal = ctx?.signal || null
        // 出口目标限制：防 SSRF 打内网（本地浏览器跑在宿主进程）
        const verdict = await assertUrlAllowed(p.url, { blockedHosts, signal })
        if (!verdict.ok) return fail(`导航被拒绝：${verdict.reason}`, { errorClass: 'ssrf_blocked' })
        try {
          await sessionMgr.acquire(id.key, { signal })
          return await sessionMgr.run(id.key, async ({ page, signal: opSignal }) => {
            const res = await page.goto(verdict.url)
            let status = null
            try { if (typeof res?.status === 'function') status = res.status() } catch { /* noop */ }
            // 重定向兜底：最终落地地址同样校验
            let finalUrl = ''
            try { if (typeof res?.url === 'function') finalUrl = res.url() } catch { /* noop */ }
            if (!finalUrl) { try { finalUrl = await page.url() } catch { /* noop */ } }
            if (finalUrl) {
              const v2 = await assertUrlAllowed(finalUrl, { blockedHosts, signal: opSignal })
              if (!v2.ok) {
                try { await page.goto('about:blank') } catch { /* noop */ }
                return fail(`导航被重定向到受限地址，已终止：${v2.reason}`, { errorClass: 'ssrf_blocked' })
              }
            }
            let title = ''
            try { title = await page.title() } catch { /* noop */ }
            const payload = { url: finalUrl || verdict.url, title, ...(status != null ? { status } : {}) }
            // 顶层字段 + data 别名：兼容外部脚本从 result.data 读取，也保留契约的顶层 url/title/status
            return ok({ ...payload, data: payload })
          }, { signal })
        } catch (e) { return fail(`导航失败：${e?.message || e}`, { errorClass: e?.errorClass || e?.code }) }
      },
    }),
    defineTool({
      name: 'observe',
      category,
      description: '观察当前页面，返回可交互元素列表（按钮/链接/输入框等）。用自然语言描述想找什么，如"登录相关的可点击元素"。只读，不改页面。成功返回 {ok:true, data, metadata?}（元素列表在 result.data）。需先用 stagehand__goto 打开页面。',
      meta: { summary: '观察页面可交互元素', resultCap: 6000 },
      parameters: param.object({ instruction: param.str('想观察什么（自然语言，如"导航栏可点击项"）；留空=列出全部可交互元素') }, []),
      async execute(p, ctx) {
        const id = identityOf(ctx)
        if (!id) return needIdentity()
        const over = quotaError(id.operator); if (over) return fail(over, { errorClass: 'rate_limited' })
        const signal = ctx?.signal || null
        try {
          return await sessionMgr.run(id.key, async ({ stagehand, page }) => {
            const r = await stagehand.observe(p.instruction || '列出页面上可交互的元素', { page })
            return ok({ data: r?.data ?? [], ...(r?.metadata ? { metadata: r.metadata } : {}) })
          }, { signal })
        } catch (e) { return fail(`observe 失败：${e?.message || e}`, { errorClass: e?.code || e?.errorClass }) }
      },
    }),
    defineTool({
      name: 'extract',
      category,
      description: '从当前页面抽取结构化数据（读取动态渲染、JS 执行后的内容）。用自然语言说"抽什么"+ 用 JSON Schema 描述结构。如抽商品标题/价格/表格行。成功返回 {ok:true, data, metadata?}（抽取结果在 result.data）。需先 stagehand__goto 打开页面。',
      meta: { summary: '抽取页面结构化数据', resultCap: 8000 },
      parameters: param.object({
        instruction: param.str('要抽取什么（自然语言，如"每个商品的名字和价格"）'),
        schema: param.str('JSON Schema 描述结构，如 {"type":"object","properties":{"title":{"type":"string"},"price":{"type":"string"}},"required":["title"]}'),
      }, ['instruction', 'schema']),
      async execute(p, ctx) {
        const id = identityOf(ctx)
        if (!id) return needIdentity()
        const over = quotaError(id.operator); if (over) return fail(over, { errorClass: 'rate_limited' })
        const signal = ctx?.signal || null
        let schemaObj
        try { schemaObj = typeof p.schema === 'string' ? JSON.parse(p.schema) : p.schema } catch { return fail('schema 不是合法 JSON', { errorClass: 'bad_schema' }) }
        let zodSchema
        try { zodSchema = jsonSchemaToZod(schemaObj) } catch (e) { return fail(`schema 转换失败：${e?.message || e}`, { errorClass: 'bad_schema' }) }
        try {
          return await sessionMgr.run(id.key, async ({ stagehand, page }) => {
            const r = await stagehand.extract(p.instruction, zodSchema, { page })
            return ok({ data: r?.data, ...(r?.metadata ? { metadata: r.metadata } : {}) })
          }, { signal })
        } catch (e) { return fail(`extract 失败：${e?.message || e}`, { errorClass: e?.code || e?.errorClass }) }
      },
    }),
    defineTool({
      name: 'act',
      category,
      description: '在当前页面上执行动作（点击/输入/选择/提交等）。用自然语言描述，如"在搜索框输入 deepseek 并回车"或"点击登录按钮"。写动作，每次需主人 #确认。成功返回 {ok:true, data}（含 success/message/actions），仅当 SDK 返回 success===true 才算成功。需先 stagehand__goto 打开页面。',
      meta: { summary: '执行页面动作(点击/输入/提交)', alwaysConfirm: true, interactive: true },
      parameters: param.object({ instruction: param.str('要执行的动作（自然语言）') }, ['instruction']),
      async execute(p, ctx) {
        const id = identityOf(ctx)
        if (!id) return needIdentity()
        const over = quotaError(id.operator); if (over) return fail(over, { errorClass: 'rate_limited' })
        const signal = ctx?.signal || null
        try {
          return await sessionMgr.run(id.key, async ({ stagehand, page }) => {
            const r = await stagehand.act(p.instruction, { page })
            const d = r?.data
            if (!d || d.success !== true) {
              return fail(`act 未成功：${d?.message || 'SDK 未返回 success===true'}`, { errorClass: 'act_failed', data: r })
            }
            return ok({ data: r.data, ...(r?.metadata ? { metadata: r.metadata } : {}) })
          }, { signal })
        } catch (e) { return fail(`act 失败：${e?.message || e}`, { errorClass: e?.code || e?.errorClass }) }
      },
    }),
  ]

  const pack = defineToolPack({ name: 'stagehand', description: 'Stagehand 浏览器自动化（goto/observe/extract/act）', tools })
  return { pack, sessionMgr }
}

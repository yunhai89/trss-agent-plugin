/**
 * Web 面板 API 路由（GET 只读部分；写接口见 C 阶段补充）。
 * 形状严格对齐 web/assets/js/mock.js（事实标准，非文档 TS）：
 *  - recall/conversations 返回裸数组；memories = {usedChars,limitChars,entries}
 *  - config 出口过 redactConfig（MaskedValue）
 * 文件型端点（config/scopes/logs）不依赖 runtime；KV/runtime 型调 getRuntime，失败返 5000。
 */
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import Config from '../../utils/Config.js'
import { setPath } from '../../utils/path.js'
import { presets as openaiPresets } from '../openai/presets.js'
import { presets as anthropicPresets } from '../anthropic/presets.js'
import { getRuntime, fireReminder, makeFireDispatch } from '../../apps/agent.js'
import { getGroupWorld } from '../../apps/groupworld.js'
import { parseCron } from '../agent/schedule.js'
import { redactConfig } from './redact.js'
import { listLogFiles, readLogFile, aggregateStats, queryLogFiles } from './logs.js'
import { ok, fail, asyncHandler, CODE } from './response.js'
import { listAllSuggestions, applySuggestion, removeSuggestion } from '../evolution/review.js'
import { getStickerManager } from '../sticker/manager.js'

const router = express.Router()

/** 取运行时；失败则响应 5000 并返回 null（handler 据此中断） */
async function getRt(res) {
  try { return await getRuntime() }
  catch (e) {
    fail(res, CODE.INTERNAL, `运行时未就绪：${e?.message || '可能 apiKey 未配'}`)
    return null
  }
}

/** 取 GroupWorld 服务；失败则响应 5000 并返回 null。 */
async function getGw(res) {
  try { return await getGroupWorld() }
  catch (e) {
    fail(res, CODE.INTERNAL, `GroupWorld 未就绪：${e?.message || e}`)
    return null
  }
}

// ───────────────── 文件型（不依赖 runtime） ─────────────────

// GET /api/config —— 全量配置（脱敏后）
router.get('/config', asyncHandler(async (req, res) => {
  const agent = Config.get().agent || {}
  return ok(res, redactConfig(agent))
}))

// GET /api/sticker —— 表情包库概览（启用/总数/自动采集/目录启停/仓库状态）
router.get('/sticker', asyncHandler(async (req, res) => {
  return ok(res, getStickerManager().libStats())
}))

// POST /api/sticker/dir-toggle —— 启停目录 { dir, enable } → 重建清单
router.post('/sticker/dir-toggle', asyncHandler(async (req, res) => {
  const { dir, enable } = req.body || {}
  if (!dir) return fail(res, CODE.BAD, '缺少 dir')
  const result = await getStickerManager().dirToggle(String(dir), !!enable)
  if (result?.ok === false) return fail(res, CODE.BAD, result.msg || '操作失败')
  return ok(res, result)
}))

// GET /api/scopes —— 数据隔离维度列表（扫 memories 目录反解 scopeId）
router.get('/scopes', asyncHandler(async (req, res) => {
  const dir = Config.path.memories
  const out = []
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      try { if (!fs.statSync(`${dir}/${name}`).isDirectory()) continue } catch { continue }
      const m = name.match(/^(?:u_(\d+)|g(\d+)_u(\d+)|g(\d+))$/)
      if (!m) continue
      let type, userId, groupId
      if (m[1]) { type = 'private'; userId = m[1]; groupId = null }
      else if (m[2]) { type = 'group'; groupId = m[2]; userId = m[3] }
      else { type = 'group'; groupId = m[4]; userId = '' }
      const label = type === 'private'
        ? `私聊 · ${userId}`
        : (userId ? `群${groupId} · ${userId}` : `群${groupId} · 共享`)
      out.push({ scopeId: name, type, label, userId, groupId })
    }
  }
  return ok(res, out)
}))

// GET /api/logs/files —— 会话日志文件列表（默认最新10条；支持 from/to/event/q 筛选）。返回 {items,total}
router.get('/logs/files', asyncHandler(async (req, res) => {
  const { from, to, event, q } = req.query
  const limit = Number(req.query.limit) > 0 ? Number(req.query.limit) : 10
  return ok(res, queryLogFiles(Config.path.logs, { from, to, event, q, limit }))
}))

// GET /api/logs?file= —— 单文件事件流（{file,label,events}，对齐 mock）
router.get('/logs', asyncHandler(async (req, res) => {
  const file = String(req.query.file || '')
  if (!file) return fail(res, CODE.BAD, '缺少 file 参数')
  const all = listLogFiles(Config.path.logs)
  const meta = all.find((f) => f.file === file)
  if (!meta) return fail(res, CODE.NOTFOUND, '日志文件不存在')
  const events = readLogFile(Config.path.logs, file)
  return ok(res, { file, label: meta.label, events })
}))

// ───────────────── runtime 型（依赖 getRuntime） ─────────────────

// GET /api/memories?scopeId= —— 声明式记忆双文件
router.get('/memories', asyncHandler(async (req, res) => {
  const scopeId = String(req.query.scopeId || '')
  if (!scopeId) return fail(res, CODE.BAD, '缺少 scopeId')
  const r = await getRt(res); if (!r) return
  const mem = r.memory
  const wrap = (target) => (!mem ? { usedChars: 0, limitChars: 0, entries: [] } : {
    usedChars: mem.used(target, scopeId) || 0,
    limitChars: mem.limits[target] || 0,
    entries: mem.getEntries(target, scopeId) || [],
  })
  return ok(res, { memory: wrap('memory'), user: wrap('user') })
}))

// GET /api/personas —— 人设库（内置 + 自定义）
router.get('/personas', asyncHandler(async (req, res) => {
  const r = await getRt(res); if (!r) return
  return ok(res, r.personaStore.list())
}))

// GET /api/skills —— 技能列表
router.get('/skills', asyncHandler(async (req, res) => {
  const r = await getRt(res); if (!r) return
  return ok(res, r.skills.list())
}))

// GET /api/tools —— 已注册工具列表（内置 + tools/ 自定义 + MCP，供配置中心"常驻工具"勾选）
router.get('/tools', asyncHandler(async (req, res) => {
  const r = await getRt(res); if (!r) return
  const list = typeof r.tools?.list === 'function' ? r.tools.list() : []
  return ok(res, list.map((t) => ({ id: t.name, name: t.name, description: t.description || '', category: t.category || 'query' })))
}))

// GET /api/conversations?userId=&groupId= —— 对话列表（裸数组）。无 userId 时返回全局所有 scope 的对话（每条带 scopeUserId/scopeGroupId，与概览"活跃对话"同源）
router.get('/conversations', asyncHandler(async (req, res) => {
  const r = await getRt(res); if (!r) return
  const userId = String(req.query.userId || '')
  if (!userId) {
    const all = await r.session.listAllConversations().catch(() => [])
    return ok(res, all)
  }
  const groupId = req.query.groupId || 'private'
  const list = await r.session.listConversations(userId, groupId).catch(() => [])
  return ok(res, list)
}))

// GET /api/sessions?convId=&userId=&groupId= —— 会话消息
router.get('/sessions', asyncHandler(async (req, res) => {
  const { convId, userId } = req.query
  if (!convId || !userId) return fail(res, CODE.BAD, '缺少 convId/userId')
  const r = await getRt(res); if (!r) return
  const groupId = req.query.groupId || 'private'
  const messages = await r.session.getConversation(userId, groupId, convId).catch(() => [])
  const meta = await r.session.getConversationMeta(userId, groupId, convId).catch(() => null)
  return ok(res, {
    key: r.session.convKey(userId, groupId, convId),
    scopeUserId: userId,
    updatedAt: meta?.updatedAt || Date.now(),
    messages,
  })
}))

// GET /api/recall?userId= —— 长期记忆（裸数组）
router.get('/recall', asyncHandler(async (req, res) => {
  const userId = String(req.query.userId || '')
  if (!userId) return fail(res, CODE.BAD, '缺少 userId')
  const r = await getRt(res); if (!r) return
  const list = await r.recall.listByUser(userId).catch(() => [])
  return ok(res, list)
}))

// GET /api/schedule —— 定时任务
router.get('/schedule', asyncHandler(async (req, res) => {
  const r = await getRt(res); if (!r) return
  const list = await r.schedule.listAll().catch(() => [])
  return ok(res, list)
}))

// GET /api/confirm —— 待审批队列（内存态）
router.get('/confirm', asyncHandler(async (req, res) => {
  const r = await getRt(res); if (!r) return
  return ok(res, r.confirm.list())
}))

// GET /api/suggestions?scopeId=&status= —— 进化建议（全部 status）
router.get('/suggestions', asyncHandler(async (req, res) => {
  const r = await getRt(res); if (!r) return
  const list = listAllSuggestions(r.suggestionDir, {
    scopeId: req.query.scopeId || undefined,
    status: req.query.status || undefined,
  })
  return ok(res, list)
}))

// ── Tool Evolution（工具进化：版本/状态/审批）──
// GET /api/tevo/tools —— 所有工具版本（id/tool_id/semver/status/source_hash/created_at）
router.get('/tevo/tools', asyncHandler(async (req, res) => {
  const r = await getRt(res); if (!r) return
  if (!r.toolEvo?.registry) return ok(res, [])
  return ok(res, await r.toolEvo.registry.listVersions())
}))

// POST /api/tevo/tools/:versionId/approve —— verified→stable 并注入 ToolRegistry
router.post('/tevo/tools/:versionId/approve', asyncHandler(async (req, res) => {
  const r = await getRt(res); if (!r) return
  if (!r.toolEvo?.registry) return fail(res, CODE.BAD, '工具进化未启用')
  const reg = r.toolEvo.registry
  const v = await reg.getVersion(req.params.versionId)
  if (!v) return fail(res, CODE.NOTFOUND, '版本不存在')
  if (v.status !== 'verified') return fail(res, CODE.BAD, `仅 verified 候选可采纳（当前 ${v.status}）`)
  await reg.setStatus(req.params.versionId, 'stable', { actor: 'web:' + (req.master || 'unknown'), reason: 'web 面板采纳' })
  const stable = (await reg.listStable()).find((s) => s.versionId === req.params.versionId)
  if (stable) r.tools.register(await reg.toToolContract(stable, r.toolEvo.runner))
  return ok(res, { versionId: req.params.versionId, status: 'stable' }, '已晋升 stable 并注入')
}))

// POST /api/tevo/tools/:versionId/decommission —— 淘汰（deprecated + 卸载）
router.post('/tevo/tools/:versionId/decommission', asyncHandler(async (req, res) => {
  const r = await getRt(res); if (!r) return
  if (!r.toolEvo?.registry) return fail(res, CODE.BAD, '工具进化未启用')
  const reg = r.toolEvo.registry
  const v = await reg.getVersion(req.params.versionId)
  if (!v) return fail(res, CODE.NOTFOUND, '版本不存在')
  // 淘汰只影响目标版本（审计 §4.1）：active 淘汰→自动回滚到另一 stable 或下线；非 active→仅 DB deprecated，注入不变
  const tool = await reg.getById(v.tool_id)
  const wasActive = tool?.active_version_id === req.params.versionId
  await reg.setStatus(req.params.versionId, 'deprecated', { actor: 'web:' + (req.master || 'unknown'), reason: 'web 面板淘汰' })
  let msg = '已淘汰（非 active，注入不变）'
  if (wasActive) {
    const others = await reg.listVersions({ toolId: v.tool_id, status: 'stable' })
    if (others.length) {
      const target = others[0]
      await reg.setActiveVersion(v.tool_id, target.id, { actor: 'web:' + (req.master || 'unknown'), reason: `淘汰 ${v.semver} 后回滚` })
      const stable = (await reg.listStable()).find((s) => s.versionId === target.id)
      if (stable) r.tools.register(await reg.toToolContract(stable, r.toolEvo.runner))
      msg = `已淘汰（原 active），已回滚到 ${target.semver}`
    } else {
      r.tools.unregister(v.manifest.name)
      msg = '已淘汰并下线（无其它 stable 可回滚）'
    }
  }
  return ok(res, { versionId: req.params.versionId, status: 'deprecated' }, msg)
}))

// POST /api/tevo/tools/:versionId/rollback —— 切 active 到指定 stable 版本 + 重新注入（回滚，审计 §4.1）
router.post('/tevo/tools/:versionId/rollback', asyncHandler(async (req, res) => {
  const r = await getRt(res); if (!r) return
  if (!r.toolEvo?.registry) return fail(res, CODE.BAD, '工具进化未启用')
  const reg = r.toolEvo.registry
  const v = await reg.getVersion(req.params.versionId)
  if (!v) return fail(res, CODE.NOTFOUND, '版本不存在')
  if (v.status !== 'stable') return fail(res, CODE.BAD, '仅 stable 版本可设为当前上线（回滚目标须是已上线版本）')
  await reg.setActiveVersion(v.tool_id, req.params.versionId, { actor: 'web:' + (req.master || 'unknown'), reason: 'web 面板回滚' })
  r.tools.unregister(v.manifest.name)
  const stable = (await reg.listStable()).find((s) => s.versionId === req.params.versionId)
  if (stable) r.tools.register(await reg.toToolContract(stable, r.toolEvo.runner))
  return ok(res, { versionId: req.params.versionId, active: true }, `${v.manifest.name}@${v.semver} 已设为当前上线版本`)
}))

// GET /api/tevo/metrics —— 收敛指标（生成率/复用率/失败率/库紧凑度）
router.get('/tevo/metrics', asyncHandler(async (req, res) => {
  const r = await getRt(res); if (!r) return
  if (!r.toolEvo?.registry) return ok(res, null)
  const { convergenceMetrics } = await import('../../toolEvo/evaluator.js')
  return ok(res, await convergenceMetrics())
}))

// GET /api/tevo/health —— 失败聚类（高失败率 stable 工具，修复候选）
router.get('/tevo/health', asyncHandler(async (req, res) => {
  const r = await getRt(res); if (!r) return
  if (!r.toolEvo?.registry) return ok(res, [])
  const { failureClusters } = await import('../../toolEvo/evaluator.js')
  return ok(res, await failureClusters())
}))

// GET /api/overview —— 概览聚合（60s 缓存）
let _overviewCache = null
router.get('/overview', asyncHandler(async (req, res) => {
  // 时间窗（1h/24h/7d/new=自新链路部署后/all）——「new」以 firstObservedAt 为锚，
  // 旧版本日志（无缓存字段）不进窗口，避免稀释新链路的命中率。
  // 窗口参数参与缓存键（60s 聚合缓存按窗口分桶）。
  const win = String(req.query.window || '7d')
  const r0 = aggregateStats(Config.path.logs, { since: 0, topK: 5 })
  let since
  if (win === '1h') since = Date.now() - 3600e3
  else if (win === '24h') since = Date.now() - 24 * 3600e3
  else if (win === 'new') since = r0.firstObservedAt != null ? r0.firstObservedAt - 1 : 0
  else if (win === 'all') since = 0
  else since = Date.now() - 7 * 86400000
  if (_overviewCache && _overviewCache.win === win && Date.now() - _overviewCache.at < 60000) return ok(res, _overviewCache.data)
  const r = await getRuntime().catch(() => null)
  const stats = since === 0 ? r0 : aggregateStats(Config.path.logs, { since, topK: 5 })
  const {
    tokenTrend, requestTrend, toolTop, totalRequests, totalToolCalls, totalTokens, totalCached,
    totalCacheRead, totalCacheWrite, observedInput, observedRequests, hitRequests, unobservedRequests,
    tokenHitRate, requestHitRate, warmObserved, warmHit, coldObserved, warmRequestHitRate, firstObservedAt,
  } = stats
  // perceptions（kv.scan）
  const perceptions = []
  if (r?.kv) {
    try {
      const mets = (await r.kv.scan('perception:met:')) || []
      for (const k of mets) {
        const groupId = k.slice('perception:met:'.length)
        const met = await r.kv.get(k).catch(() => null)
        const lastActive = await r.kv.get(`perception:last_active:${groupId}`).catch(() => null)
        if (met) perceptions.push({ groupId, met, lastActive: lastActive || { at: met.at || 0 } })
      }
    } catch { /* noop */ }
  }
  // 活跃对话数：group:user 会话（Yz:agent:sess:<gid>:<uid>）+ conversation 数据键（排除 active/seq 辅助键）
  let conversations = 0
  try {
    if (r?.kv) {
      const keys = (await r.kv.scan('Yz:agent:sess:')) || []
      const isAux = (k) => k.includes(':conv:active:') || k.includes(':conv:seq:')
      conversations = keys.filter((k) => !isAux(k)).length
    }
  } catch { /* noop */ }
  const counts = {
    pendingConfirms: r ? r.confirm.list().length : 0,
    pendingSuggestions: r ? listAllSuggestions(r.suggestionDir, { status: 'pending' }).length : 0,
    scopes: fs.existsSync(Config.path.memories) ? fs.readdirSync(Config.path.memories).length : 0,
    conversations,
  }
  const data = {
    tokenTrend, requestTrend, toolTop, totalRequests, totalToolCalls, totalTokens, totalCached, perceptions, counts,
    // 缓存统计（观测口径）：未观测 ≠ 0 命中；cold/warm 分层；比率 null=无观测数据（前端显示「暂无」）
    cache: { totalCacheRead, totalCacheWrite, observedInput, observedRequests, hitRequests, unobservedRequests, tokenHitRate, requestHitRate, warmObserved, warmHit, coldObserved, warmRequestHitRate, firstObservedAt },
  }
  _overviewCache = { at: Date.now(), win, data }
  return ok(res, data)
}))

// ── SelfState 自我状态（主人面板 §19）──
import { getSelfState } from '../../apps/humanize.js'
async function getSs(res) {
  try { return await getSelfState() }
  catch (e) { fail(res, CODE.INTERNAL, `SelfState 未就绪：${e?.message || e}`); return null }
}
router.get('/selfstate/overview', asyncHandler(async (req, res) => {
  const ss = await getSs(res); if (!ss) return
  const groupId = String(req.query.groupId || '')
  if (!groupId) return fail(res, CODE.BAD, '缺少 groupId')
  return ok(res, await ss.getOverview(groupId))
}))
router.get('/selfstate/relations', asyncHandler(async (req, res) => {
  const ss = await getSs(res); if (!ss) return
  const groupId = String(req.query.groupId || '')
  if (!groupId) return fail(res, CODE.BAD, '缺少 groupId')
  return ok(res, await ss.getRelations(groupId))
}))
router.post('/selfstate/reset', asyncHandler(async (req, res) => {
  const ss = await getSs(res); if (!ss) return
  if (!req.body?.groupId) return fail(res, CODE.BAD, '缺少 groupId')
  await ss.resetGroupState(req.body.groupId)
  return ok(res, { ok: true }, '已重置该群自我状态')
}))
router.post('/selfstate/clear-member', asyncHandler(async (req, res) => {
  const ss = await getSs(res); if (!ss) return
  const { groupId, userId } = req.body || {}
  if (!groupId || !userId) return fail(res, CODE.BAD, '缺少 groupId 或 userId')
  await ss.clearMemberResidue(groupId, userId)
  return ok(res, { ok: true }, '已清除该成员情感残留')
}))
router.post('/selfstate/freeze', asyncHandler(async (req, res) => {
  const ss = await getSs(res); if (!ss) return
  const { groupId, frozen } = req.body || {}
  if (!groupId) return fail(res, CODE.BAD, '缺少 groupId')
  await ss.setExpressionFrozen(groupId, !!frozen)
  return ok(res, { ok: true }, frozen ? '已冻结情绪外显' : '已解冻')
}))

// ── 群聊小世界 GroupWorld 数据浏览（主人面板；§12.3 web 仅限主人，群内仅自查）──
// GET /api/groupworld/stats?groupId= —— 数据规模 + 任务状态 + 今日调用
router.get('/groupworld/stats', asyncHandler(async (req, res) => {
  const gw = await getGw(res); if (!gw) return
  const groupId = String(req.query.groupId || '')
  if (!groupId) return fail(res, CODE.BAD, '缺少 groupId')
  if (!gw.isReady()) return ok(res, { ready: false })
  return ok(res, await gw.getStats(groupId))
}))

// GET /api/groupworld/members?groupId=&tier=&limit=&offset= —— 成员列表
router.get('/groupworld/members', asyncHandler(async (req, res) => {
  const gw = await getGw(res); if (!gw) return
  const groupId = String(req.query.groupId || '')
  if (!groupId) return fail(res, CODE.BAD, '缺少 groupId')
  if (!gw.isReady()) return ok(res, [])
  return ok(res, await gw.listMembers(groupId, { tier: req.query.tier || null, limit: req.query.limit, offset: req.query.offset }))
}))

// GET /api/groupworld/profile?groupId=&userId= —— 单成员画像详情（特征+证据+主观关系+一跳边）
router.get('/groupworld/profile', asyncHandler(async (req, res) => {
  const gw = await getGw(res); if (!gw) return
  const groupId = String(req.query.groupId || '')
  const userId = String(req.query.userId || '')
  if (!groupId || !userId) return fail(res, CODE.BAD, '缺少 groupId 或 userId')
  if (!gw.isReady()) return ok(res, null)
  return ok(res, await gw.getProfileDetail(groupId, userId))
}))

// GET /api/groupworld/episodes?groupId= —— 群事件/群梗
router.get('/groupworld/episodes', asyncHandler(async (req, res) => {
  const gw = await getGw(res); if (!gw) return
  const groupId = String(req.query.groupId || '')
  if (!groupId) return fail(res, CODE.BAD, '缺少 groupId')
  if (!gw.isReady()) return ok(res, [])
  return ok(res, await gw.listEpisodes(groupId, { limit: req.query.limit }))
}))

// GET /api/groupworld/communities?groupId= —— 小圈子
router.get('/groupworld/communities', asyncHandler(async (req, res) => {
  const gw = await getGw(res); if (!gw) return
  const groupId = String(req.query.groupId || '')
  if (!groupId) return fail(res, CODE.BAD, '缺少 groupId')
  if (!gw.isReady()) return ok(res, [])
  return ok(res, await gw.listCommunities(groupId, { limit: req.query.limit }))
}))

// ── OpenRouter（模型目录 + key 余额；config.agent.apiKey 作 Bearer）──
// GET /api/openrouter/models —— 模型目录（公开端点，有 key 则带 Bearer）
router.get('/openrouter/models', asyncHandler(async (req, res) => {
  const apiKey = Config.get().agent?.apiKey
  const r = await fetch('https://openrouter.ai/api/v1/models', { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, signal: AbortSignal.timeout(15000) }).catch(() => null)
  if (!r?.ok) return fail(res, CODE.INTERNAL, `OpenRouter 模型列表获取失败（HTTP ${r?.status || '网络错误'}）`)
  const data = await r.json().catch(() => null)
  const list = (data?.data || []).map((m) => ({ id: m.id, name: m.name, context: m.context_length, prompt: m.pricing?.prompt, completion: m.pricing?.completion }))
  return ok(res, list)
}))

// GET /api/openrouter/key —— 查询 key 余额/用量（需 agent.apiKey 为 OpenRouter key）
router.get('/openrouter/key', asyncHandler(async (req, res) => {
  const apiKey = Config.get().agent?.apiKey
  if (!apiKey) return fail(res, CODE.BAD, '未配置 agent.apiKey')
  const r = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15000) }).catch(() => null)
  if (!r?.ok) {
    const t = await r?.text().catch(() => '')
    return fail(res, CODE.INTERNAL, `OpenRouter key 查询失败（HTTP ${r?.status}）${r?.status === 401 ? '（agent.apiKey 非 OpenRouter key 或已失效——确认 preset=openrouter 且 apiKey 为 sk-or- 开头的 OpenRouter key）' : ''}${t ? '：' + t.slice(0, 120) : ''}`)
  }
  const data = await r.json().catch(() => null)
  return ok(res, data?.data || data)
}))

// ── 通用模型列表（按当前 protocol/baseURL/apiKey/preset 拉取厂商可用模型，供配置中心模型 ID 选择）──
// GET /api/models?protocol=&baseURL=&apiKey=&preset= —— 返回 [{id, name?}]；纯代理不落盘。
router.get('/models', asyncHandler(async (req, res) => {
  const agent = Config.get().agent || {}
  const protocol = String(req.query.protocol || agent.protocol || 'openai').toLowerCase()
  const preset = String(req.query.preset || agent.preset || '').toLowerCase()
  const apiKey = String(req.query.apiKey || agent.apiKey || '')
  // 解析 baseURL：查询参 > preset 预设 > config.agent.baseURL（去尾部斜杠）
  let baseURL = String(req.query.baseURL || '').trim().replace(/\/+$/, '')
  if (!baseURL) {
    try {
      const map = protocol === 'anthropic' ? anthropicPresets : openaiPresets
      baseURL = (map[preset]?.baseURL || agent.baseURL || '').trim().replace(/\/+$/, '')
    } catch { baseURL = String(agent.baseURL || '').trim().replace(/\/+$/, '') }
  }
  if (!baseURL) return fail(res, CODE.BAD, '未配置 baseURL，且无法从厂商预设解析（请在表单填接口地址）')
  if (!apiKey) return fail(res, CODE.BAD, '未配置 apiKey，无法拉取模型列表')

  const timeout = () => AbortSignal.timeout(15000)
  try {
    let list = []
    if (protocol === 'gemini') {
      // Gemini 原生：GET .../v1beta/models?key=
      // preset.baseURL 形如 .../v1beta/openai（OpenAI 兼容入口）：去掉 /openai 后缀复用其 /v1beta 根。
      // root 已含 /v1beta 则直接 /models，否则补 /v1beta/models（兼容用户填裸域名）。
      const root = baseURL.replace(/\/openai\/?$/, '').replace(/\/+$/, '')
      const gpath = /\/v1beta(\/|$)/.test(root) ? '/models' : '/v1beta/models'
      const r = await fetch(`${root}${gpath}?key=${encodeURIComponent(apiKey)}&pageSize=1000`, { signal: timeout() }).catch(() => null)
      if (!r?.ok) {
        const t = await r?.text().catch(() => '')
        return fail(res, CODE.INTERNAL, `Gemini 模型列表获取失败（HTTP ${r?.status || '网络错误'}）${t ? '：' + t.slice(0, 120) : ''}`)
      }
      const data = await r.json().catch(() => null)
      list = (data?.models || []).map((m) => ({ id: String(m.name || '').replace(/^models\//, ''), name: m.displayName }))
    } else if (protocol === 'anthropic') {
      // Anthropic 兼容：GET {baseURL}/v1/models（client 同款 /v1 前缀）+ x-api-key + anthropic-version
      // 去尾部 /v1（防用户填带 /v1 的地址导致 /v1/v1/models）
      const ap = anthropicPresets[preset] || {}
      const authHeader = ap.authHeader || 'x-api-key'
      const headers = { [authHeader]: apiKey, 'anthropic-version': ap.version || '2023-06-01' }
      const ab = baseURL.replace(/\/v1\/?$/, '').replace(/\/+$/, '')
      const r = await fetch(`${ab}/v1/models`, { headers, signal: timeout() }).catch(() => null)
      if (!r?.ok) {
        const t = await r?.text().catch(() => '')
        return fail(res, CODE.INTERNAL, `模型列表获取失败（HTTP ${r?.status || '网络错误'}）${t ? '：' + t.slice(0, 120) : ''}`)
      }
      const data = await r.json().catch(() => null)
      list = (data?.data || data?.models || []).map((m) => ({ id: m.id || m.name, name: m.display_name || m.name }))
    } else {
      // OpenAI 兼容（deepseek/dashscope/zhipu/moonshot/mimo/minimax/openrouter/opencode 等）：GET {baseURL}/models
      const r = await fetch(`${baseURL}/models`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: timeout() }).catch(() => null)
      if (!r?.ok) {
        const t = await r?.text().catch(() => '')
        return fail(res, CODE.INTERNAL, `模型列表获取失败（HTTP ${r?.status || '网络错误'}）${t ? '：' + t.slice(0, 120) : ''}`)
      }
      const data = await r.json().catch(() => null)
      list = (data?.data || data?.models || []).map((m) => ({ id: m.id || m.name, name: m.name || m.id }))
    }
    // 去空 id + 去重 + 按 id 排序
    const seen = new Set()
    list = list
      .filter((m) => m.id && !seen.has(m.id) && seen.add(m.id))
      .sort((a, b) => (a.id < b.id ? -1 : 1))
    return ok(res, list)
  } catch (e) {
    return fail(res, CODE.INTERNAL, `模型列表获取异常：${e?.message || e}`)
  }
}))

// ───────────────── 写操作（9 类，成功触发 Config 热加载或落盘） ─────────────────

// PUT /api/config —— 点路径 changes（对齐锅巴 setConfigData）
router.put('/config', asyncHandler(async (req, res) => {
  const { changes } = req.body || {}
  if (!changes || typeof changes !== 'object') return fail(res, CODE.BAD, 'changes 必须是对象')
  const cfg = Config.get()
  let n = 0
  for (const [p, v] of Object.entries(changes)) {
    if (!p.startsWith('agent.')) continue // 仅允许 agent.* 命名空间
    setPath(cfg, p, v)
    n++
  }
  Config.save(cfg)
  Config.reload(true)
  return ok(res, { applied: n }, '已保存（已热加载）')
}))

// PUT /api/memories/:scopeId/:target —— 全量替换条目（超限 4001）
router.put('/memories/:scopeId/:target', asyncHandler(async (req, res) => {
  const { scopeId, target } = req.params
  if (target !== 'memory' && target !== 'user') return fail(res, CODE.BAD, 'target 必须是 memory|user')
  const entries = req.body?.entries
  if (!Array.isArray(entries)) return fail(res, CODE.BAD, 'entries 必须是字符串数组')
  const r = await getRt(res); if (!r) return
  try {
    const result = r.memory.setAll(target, entries, scopeId)
    return ok(res, result)
  } catch (e) {
    if (e?.name === 'MemoryLimitError' || /超限/.test(e?.message || '')) return fail(res, CODE.BAD, e.message)
    throw e
  }
}))

// POST /api/recall/:userId —— 新增（写入过威胁扫描）
router.post('/recall/:userId', asyncHandler(async (req, res) => {
  const r = await getRt(res); if (!r) return
  const { level, type, content, confidence } = req.body || {}
  if (!content) return fail(res, CODE.BAD, '缺少 content')
  const result = await r.recall.writeMemory(
    { level: level || 'L3', type: type || 'fact', content: String(content), confidence: Number(confidence) || 0.5 },
    req.params.userId,
  )
  return ok(res, result)
}))

// DELETE /api/recall/:userId/:entryId —— 按 id 删
router.delete('/recall/:userId/:entryId', asyncHandler(async (req, res) => {
  const r = await getRt(res); if (!r) return
  const removed = await r.recall.removeById(req.params.userId, req.params.entryId)
  return ok(res, { removed })
}))

// ── 知识库（Knowledge Base）──
// GET /api/kb —— 文档列表
router.get('/kb', asyncHandler(async (req, res) => {
  const r = await getRt(res); if (!r) return
  return ok(res, await r.knowledge.listDocs().catch(() => []))
}))

// POST /api/kb —— 文档入库 { title, text }
router.post('/kb', asyncHandler(async (req, res) => {
  const r = await getRt(res); if (!r) return
  const { title, text } = req.body || {}
  if (!text) return fail(res, CODE.BAD, '缺少 text')
  const result = await r.knowledge.ingest(String(text), { title: title || '' })
  if (result.error) return fail(res, CODE.BAD, result.error)
  return ok(res, result)
}))

// DELETE /api/kb/:id —— 删除文档
router.delete('/kb/:id', asyncHandler(async (req, res) => {
  const r = await getRt(res); if (!r) return
  const n = await r.knowledge.removeDoc(req.params.id)
  return ok(res, { removed: n })
}))

// POST /api/kb/rebuild —— 重建向量索引（换 embedding 模型后）
router.post('/kb/rebuild', asyncHandler(async (req, res) => {
  const r = await getRt(res); if (!r) return
  const result = await r.knowledge.rebuild()
  if (result.error) return fail(res, CODE.BAD, result.error)
  return ok(res, result)
}))

// POST /api/kb/url —— 网页 URL 抓取入库 { url, title?, refreshCron? }
router.post('/kb/url', asyncHandler(async (req, res) => {
  const r = await getRt(res); if (!r) return
  const { url, title, refreshCron } = req.body || {}
  if (!url) return fail(res, CODE.BAD, '缺少 url')
  const result = await r.knowledge.ingestUrl(String(url), { title: title || '', refreshCron: refreshCron || null })
  if (result.error) return fail(res, CODE.BAD, result.error)
  return ok(res, result)
}))

// POST /api/kb/:id/refresh —— 刷新某网页文档（重新抓取更新 chunks）
router.post('/kb/:id/refresh', asyncHandler(async (req, res) => {
  const r = await getRt(res); if (!r) return
  const result = await r.knowledge.refreshDoc(req.params.id)
  if (result.error) return fail(res, CODE.BAD, result.error)
  return ok(res, result)
}))

// POST /api/kb/:id/schedule —— 设定时刷新 { cron }（cron=null 或省略=取消）
router.post('/kb/:id/schedule', asyncHandler(async (req, res) => {
  const r = await getRt(res); if (!r) return
  const { cron } = req.body || {}
  const result = await r.knowledge.setRefresh(req.params.id, cron ? String(cron) : null)
  if (result.error) return fail(res, CODE.BAD, result.error)
  return ok(res, result)
}))

// DELETE /api/kb/:id/schedule —— 取消定时刷新
router.delete('/kb/:id/schedule', asyncHandler(async (req, res) => {
  const r = await getRt(res); if (!r) return
  const result = await r.knowledge.cancelRefresh(req.params.id)
  return ok(res, result)
}))

// POST /api/personas —— 新建自定义人设
router.post('/personas', asyncHandler(async (req, res) => {
  const r = await getRt(res); if (!r) return
  try { return ok(res, r.personaStore.add(req.body, { creator: req.master })) }
  catch (e) { return fail(res, CODE.BAD, e.message) }
}))

// PUT /api/personas/:id —— 编辑（内置 4003）
router.put('/personas/:id', asyncHandler(async (req, res) => {
  const r = await getRt(res); if (!r) return
  try { return ok(res, r.personaStore.update(req.params.id, req.body)) }
  catch (e) { const msg = e.message || ''; return fail(res, /内置/.test(msg) ? CODE.READONLY : CODE.BAD, msg) }
}))

// DELETE /api/personas/:id —— 删除（内置 4003）
router.delete('/personas/:id', asyncHandler(async (req, res) => {
  const r = await getRt(res); if (!r) return
  try { return ok(res, { removed: r.personaStore.remove(req.params.id) }) }
  catch (e) { const msg = e.message || ''; return fail(res, /内置/.test(msg) ? CODE.READONLY : CODE.BAD, msg) }
}))

// POST /api/schedule —— 新建任务（type='task'=cron 重复任务链；默认=一次性提醒）
router.post('/schedule', asyncHandler(async (req, res) => {
  const r = await getRt(res); if (!r) return
  const { userId, groupId, message, at, type, cron, when, prompt } = req.body || {}
  if (!userId) return fail(res, CODE.BAD, '缺少 userId')
  const isTask = type === 'task'
  let cronVal = ''
  if (isTask) {
    cronVal = String(cron || '')
    if (!cronVal && when) cronVal = parseCron(when) || ''
    if (!cronVal || !prompt) return fail(res, CODE.BAD, 'task 需时间(when/cron) + prompt')
  } else if (!message || !at) {
    return fail(res, CODE.BAD, '缺少 message/at')
  }
  const info = {
    userId: String(userId), groupId: groupId || null, selfId: '',
    type: isTask ? 'task' : 'reminder',
    ...(isTask ? { cron: cronVal, prompt: String(prompt) } : { message: String(message), at: Number(at) }),
  }
  const ret = await r.schedule.add(info, isTask ? makeFireDispatch(r) : fireReminder)
  const id = ret && typeof ret === 'object' ? ret.id : ret
  return ok(res, { id })
}))

// DELETE /api/schedule/:id —— 取消
router.delete('/schedule/:id', asyncHandler(async (req, res) => {
  const r = await getRt(res); if (!r) return
  const ret = await r.schedule.cancel(req.params.id)
  return ok(res, { removed: ret ? 1 : 0 })
}))

// POST /api/confirm/:id/decide —— 审批决策（不存在/超时 4004）
router.post('/confirm/:id/decide', asyncHandler(async (req, res) => {
  const r = await getRt(res); if (!r) return
  const exists = r.confirm.list().some((c) => c.id === req.params.id)
  if (!exists) return fail(res, CODE.NOTFOUND, '审批项不存在或已超时')
  r.confirm.resolve(req.params.id, !!req.body?.approve)
  return ok(res, { decided: true })
}))

// POST /api/suggestions/:id/apply —— 应用（失败置 apply_failed）
router.post('/suggestions/:id/apply', asyncHandler(async (req, res) => {
  const r = await getRt(res); if (!r) return
  const s = listAllSuggestions(r.suggestionDir).find((x) => x.id === req.params.id)
  if (!s) return fail(res, CODE.NOTFOUND, 'suggestion 不存在')
  try {
    const applyResult = await applySuggestion(r, s)
    return ok(res, { ...s, status: 'applied', applyResult })
  } catch (e) {
    s.status = 'apply_failed'
    s.error = e.message
    try { fs.writeFileSync(path.join(r.suggestionDir, String(s.scopeId), `${s.id}.json`), JSON.stringify(s, null, 2)) } catch { /* noop */ }
    return fail(res, CODE.INTERNAL, e.message)
  }
}))

// DELETE /api/suggestions/:id —— 驳回（删除文件）
router.delete('/suggestions/:id', asyncHandler(async (req, res) => {
  const r = await getRt(res); if (!r) return
  const s = listAllSuggestions(r.suggestionDir).find((x) => x.id === req.params.id)
  if (!s) return fail(res, CODE.NOTFOUND, 'suggestion 不存在')
  removeSuggestion(r.suggestionDir, s.scopeId, s.id)
  return ok(res, { removed: true })
}))

// 未知 /api 路径 → JSON 404（不走 SPA fallback）
router.use((req, res) => fail(res, CODE.NOTFOUND, `未知接口 ${req.method} ${req.path}`))

export function buildApiRouter() {
  return router
}

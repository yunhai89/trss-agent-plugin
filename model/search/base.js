/**
 * 搜索统一抽象 —— 所有 provider 实现同一接口，返回同一结果类型。
 *
 * SearchResult: { provider, query, results: [{title,url,content,score?}], answer?, citations?, raw? }
 * SearchProvider: { name, available(), async search(query, opts) → SearchResult, async extract?(urls, opts) }
 */

function truncate(s, n) {
  s = String(s ?? '')
  return s.length > n ? `${s.slice(0, n)}...` : s
}

/**
 * 统一格式化为 Agent 可消费的简洁文本。
 * 兼容两种形态：
 *  - 单查询：{ answer, results:[{title,url,content,score?}], citations? }
 *  - 多查询合并（searchMany）：{ answers:[{query,answer}], results:[{...,source,query,published?}], failures:[{query,error}], sources }
 * 每条结果在可用时带「来源/时间」元信息，便于模型判断来源是否独立、信息是否过时（交叉验证的前提）。
 */
export function formatResults(result, { maxResults = 10, maxContent = 500 } = {}) {
  if (!result) return '(无搜索结果)'
  const parts = []
  const answers = Array.isArray(result.answers) ? result.answers : (result.answer ? [{ query: result.query, answer: result.answer }] : [])
  for (const a of answers) {
    if (a?.answer) parts.push(`💡 ${Array.isArray(result.answers) && a.query ? `[${a.query}] ` : ''}${a.answer}`)
  }
  if (result.results?.length) {
    const items = result.results.slice(0, maxResults).map((r, i) => {
      const meta = [
        r.source ? `来源: ${r.source}` : '',
        (r.published || r.date) ? `时间: ${r.published || r.date}` : '',
        r.score != null ? `score: ${Number(r.score).toFixed(2)}` : '',
      ].filter(Boolean).join(' · ')
      return `[${i + 1}] ${r.title || '(无标题)'}${meta ? ` (${meta})` : ''}\n    ${r.url}\n    ${truncate(r.content, maxContent)}`
    })
    parts.push(items.join('\n\n'))
  }
  if (result.citations?.length) parts.push(`📎 引用：${result.citations.slice(0, 5).join(' ')}`)
  // 多查询合并时：部分查询失败必须显式提示覆盖缺口（否则模型可能把"只查到一边"当成"只有一边"）
  if (result.failures?.length) {
    parts.push(`⚠️ 部分查询未成功，结论需考虑覆盖缺口：${result.failures.map((f) => `「${f.query}」${f.error}`).join('；')}`)
  }
  if (parts.length) return parts.join('\n\n')
  // 所有源都返回空：给出可执行提示，避免模型直接断言"搜不到/没有相关信息"而放弃
  const sources = result.sources?.length ? result.sources.join('/') : result.provider
  return `(无搜索结果${sources ? `：${sources} 等搜索源均未返回内容` : ''}。可换更短的关键词重试；国创/中国内容改用国内源——米游社 miyoushe_search、B站 bilibili、web_crawl 抓 wiki.biligame.com/萌娘百科；仍为空再考虑浏览器自动化（tool_search 搜“浏览器 打开网页”激活 stagehand__goto），或告知用户搜索暂时不可用)`
}

/** 格式化提取结果 */
export function formatExtract(res) {
  const ok = (res.results || []).map((r) => `${r.url}:\n${truncate(r.raw_content || r.content || '', 2000)}`)
  const failed = (res.failed || []).map((f) => `❌ ${f.url || f}`)
  const parts = [...ok]
  if (failed.length) parts.push(`提取失败的 URL：\n${failed.join('\n')}`)
  return parts.join('\n\n---\n\n') || '(无内容)'
}

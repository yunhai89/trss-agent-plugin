/**
 * 工具结果「软失败」判定 —— 全仓唯一实现。
 *
 * 历史教训：这里曾有两份口径不同的实现，且互相漂移：
 *  - `Agent.isToolError`（账本/恢复/澄清短路用它）：结构化判定，但不认 MCP 的纯文本错误；
 *  - `ToolRegistry.isErrorShape`（AOP 日志/usage-stats 用它）：无锚点子串 `/"error"\s*:/`，
 *    工具返回的**正文**里只要出现字面量 `"error":`（API 文档、Issue 页、JSON 代码示例、用户笔记）
 *    就被判成失败 —— 注入「这是失败原因，请如实回复」提示、账本记 toolFailed、写操作 effectState
 *    从 applied 变 unknown（恢复计划要求人工核对）。
 * 两处判定不一致还会让 AOP/统计与账本对同一次调用得出相反结论。
 *
 * 统一规则（保守但不误判）：
 *  - 对象：`error != null` / `ok === false` / `isError === true`；数组：任一元素满足；
 *  - 字符串：JSON 形态按上述结构判定（截断/非法 JSON 只认规范前缀 `{"error"`，不匹配正文）；
 *  - 非 JSON 纯文本：只认 MCP 文本错误约定（`Error:` / `error:` 开头），不扩大到正文子串匹配。
 */

function shape(o) {
  return !!o && typeof o === 'object' && !Array.isArray(o)
    && (o.error != null || o.ok === false || o.isError === true)
}

/**
 * @param {*} content 工具返回值（字符串或对象）
 * @returns {boolean} 是否为「软失败」（工具没抛异常，但以错误对象/串报错）
 */
export function isToolErrorContent(content) {
  if (content == null) return false
  if (typeof content === 'object') return Array.isArray(content) ? content.some(shape) : shape(content)
  if (typeof content !== 'string') return false
  const s = content.trim()
  if (!s) return false
  if (s.startsWith('{') || s.startsWith('[')) {
    try {
      const o = JSON.parse(s)
      return Array.isArray(o) ? o.some(shape) : shape(o)
    } catch { return /^\{\s*"error"\s*:/.test(s) } // 截断/非法 JSON：只认规范前缀，不误判正文
  }
  return /^error\b/i.test(s) // MCP 文本错误约定（如 "Error: ENOENT ..."）
}

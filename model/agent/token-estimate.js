/**
 * token 估算（CJK 感知）——压缩水位与断点判定的统一口径。
 *
 * 中日韩字符按 ~1 token/字，其余按 ~1 token/4 字符。
 *
 * 为什么不沿用「字符数 ÷ 4」：中文/日文/韩文实际约 1 token/字，统一 ÷4 会系统性低估
 * 2~4 倍，导致 `contextWindow` 名义值与真实请求量脱钩——实测中文会话的真实 prompt 可达
 * 估算值的 1.5~2.4 倍（配置 32K 的会话真实请求能涨到 140K token），既让压缩时机不可
 * 预期，也可能顶穿模型真实上下文窗口。`Agent` 的 `config.estimateTokens` 仍可覆盖本估算。
 */
export function estimateTokensApprox(text) {
  const s = typeof text === 'string' ? text : String(text ?? '')
  if (!s) return 0
  let wide = 0
  let total = 0
  for (const ch of s) {
    total++
    const c = ch.codePointAt(0)
    if ((c >= 0x2e80 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff) ||
        (c >= 0x3040 && c <= 0x30ff) || (c >= 0xff00 && c <= 0xffef) || (c >= 0x20000 && c <= 0x3ffff)) wide++
  }
  return Math.ceil(wide + (total - wide) / 4)
}

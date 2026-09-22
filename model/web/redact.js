/**
 * 配置出口处理。
 *
 * 自用面板：除下方 Jev 专用掩码外，所有字段（含 apiKey / baseURL / proxy / cookie / refreshToken /
 * masters / mcp.servers.*.env·headers / stt.apiKey 等）一律明文返回，便于在 web 面板直接查看与编辑。
 * 用户明确选择「全部不脱敏」，接受浏览器残留 / 截图泄露风险；非密钥托管场景。
 *
 * 例外：agent.jev.apiKey（发往第三方 TypeSafe 的 Key）按安全要求**只显示掩码**——
 * redactConfig 深拷贝后把非空 key 替换为 JEV_KEY_MASK；写回时（api.js / guoba.support.js）
 * 若收到该掩码则视为"未修改"跳过，避免把掩码写进配置。绝不修改原 Config。
 */
const clone = (o) => (typeof structuredClone === 'function' ? structuredClone(o) : JSON.parse(JSON.stringify(o)))

/** Jev API Key 掩码占位（前端显示；提交时被后端识别为"未修改"） */
export const JEV_KEY_MASK = '••••••••（已保存，留空/不改则保留）'

/** 入口：深拷贝 agent 配置，Jev Key 掩码，其余原样明文返回。 */
export function redactConfig(agentCfg) {
  const out = clone(agentCfg)
  try {
    if (out?.jev && typeof out.jev.apiKey === 'string' && out.jev.apiKey) out.jev.apiKey = JEV_KEY_MASK
  } catch { /* 深拷贝/掩码失败时原样返回，不阻塞配置读取 */ }
  return out
}

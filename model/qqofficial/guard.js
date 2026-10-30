/**
 * 规则级主人权限的「官方机器人」兜底。
 *
 * 问题：TRSS-Yunzai 的 `permission: 'master'` 由框架判定（`cfg.master[self_id].includes(String(e.user_id))`），
 * 而 QQ 官方机器人的 `e.user_id` 是 `<self_id>:<openid>` / `qg_<openid>`，不是 QQ 号——
 * 除非把 openid 原样写进框架 master 配置，否则**所有 `permission:'master'` 指令在官方机器人下永远不可用**
 * （插件里 45 条主人指令全部受影响，`#agent重载`、`#知识库添加` 等会直接回「暂无权限」）。
 *
 * 方案：把规则级 master 校验下沉到插件内——规则改为 `permission: 'all'`，方法入口用
 * `agent.masters`（支持完整/去前缀 openid）或框架 `e.isMaster` 复核；两处代码集中在
 * model/qqofficial/guard.js，各 app 构造器调用 `installMasterGate(this)` 即可。
 *
 * 兼容性：非官方协议下判定等价于框架（e.isMaster），只是拒绝文案换成带排障提示的版本；
 * 规则对象与原型方法只包裹一次（幂等），不会随消息条数增长。
 */

import Config from '../../utils/Config.js'
import { detectAdapter } from './index.js'

/**
 * 主人判定（与 apps/agent.js 的 isCtxMaster 同口径；此处独立实现避免循环依赖）。
 * @param {object} e 事件
 * @param {object} [cfg] agent 配置块，或整份配置（含 .agent）；缺省读 Config
 */
export function isOfficialMaster(e, cfg = null) {
  if (e?.isMaster) return true
  const adapter = detectAdapter(e)
  if (!adapter.official) return false
  const agentCfg = (cfg?.agent ? cfg.agent : cfg) || Config.get()?.agent || {}
  const masters = Array.isArray(agentCfg?.masters) ? agentCfg.masters.map((m) => String(m).trim()).filter(Boolean) : []
  if (!masters.length) return false
  const full = String(e?.user_id ?? '')
  let raw = full
  const selfId = String(e?.self_id || e?.bot?.uin || '')
  if (selfId && raw.startsWith(`${selfId}:`)) raw = raw.slice(selfId.length + 1)
  if (raw.startsWith('qg_')) raw = raw.slice(3)
  return (full && masters.includes(full)) || (raw && masters.includes(raw))
}

/** 拒绝提示（带可操作指引；官方机器人用户按 /uid 值补配置即可） */
export const MASTER_DENIED_TEXT = '⚠️ 该指令仅主人可用。'
  + '\n如果是主人：把 /uid 打印的「完整 user_id」加入 agent.masters，'
  + '或加入 Yunzai 主人配置（config/config.yaml → master）后重试。'

/**
 * 把插件实例的 `permission:'master'` 规则改成插件内判定。
 * 需在构造器 super() 之后调用（此时 this.rule 已存在）。
 * @param {object} plugin 插件实例（Yunzai plugin 子类实例）
 */
export function installMasterGate(plugin) {
  const rules = Array.isArray(plugin?.rule) ? plugin.rule : []
  if (!rules.length) return
  const proto = Object.getPrototypeOf(plugin)
  if (!proto) return
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') continue
    if (rule.permission !== 'master' && rule.__masterGate !== true) continue
    // 规则级 master → all，并打上标记（规则数组是类级共享对象，只需改一次）
    if (rule.permission === 'master') {
      rule.permission = 'all'
      rule.__masterGate = true
    }
    const fnc = typeof rule.fnc === 'string' ? rule.fnc : null
    if (!fnc) continue
    const orig = proto[fnc]
    if (typeof orig !== 'function' || orig.__masterGated) continue
    const wrapped = async function masterGatedFnc(e, ...rest) {
      const ev = this?.e || e
      let allow = false
      try { allow = isOfficialMaster(ev) } catch { allow = !!ev?.isMaster }
      if (!allow) {
        try { return await ev?.reply?.(MASTER_DENIED_TEXT) } catch { return true }
      }
      return orig.call(this, e, ...rest)
    }
    wrapped.__masterGated = true
    wrapped.__masterOriginal = orig
    proto[fnc] = wrapped
  }
}

/** 供测试/排障：把「官方 ID 形态」判定结果翻出来（不做权限决策） */
export function describeMasterGate(plugin) {
  const rules = Array.isArray(plugin?.rule) ? plugin.rule : []
  return rules
    .filter((r) => r && (r.__masterGate || r.permission === 'master'))
    .map((r) => ({ fnc: r.fnc, permission: r.permission, gated: r.__masterGate === true }))
}

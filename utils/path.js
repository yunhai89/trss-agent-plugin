/** 点路径工具（web 路由与 guoba 共用，避免重复实现） */

/**
 * 禁止作为路径段的键（原型污染防护）：
 * `setPath(cfg, 'agent.__proto__.polluted', 1)` 会沿 `agent.__proto__` 走到 Object.prototype
 * 并把污染写入其中（进程级、影响所有对象/所有插件）；`constructor`/`prototype` 同族可用。
 * 任何一段命中即拒绝，不做「跳过继续」——静默跳过会让调用方以为写入成功。
 */
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])

/** 校验点路径；含非法段时抛错（错误消息可直接回给调用方） */
export function assertSafePath(p) {
  const keys = String(p ?? '').split('.')
  for (const k of keys) {
    if (FORBIDDEN_SEGMENTS.has(k)) throw new Error(`非法路径段「${k}」（不允许 __proto__/prototype/constructor）`)
  }
  return keys
}

/** 写入时只用字面量属性，避免 setter/原型链参与 */
function assign(target, key, value) {
  Object.defineProperty(target, key, {
    value, writable: true, enumerable: true, configurable: true,
  })
}

/** 按点路径写入嵌套对象：setPath(cfg, 'agent.model', 'x')；中间节点不存在自动建 {} */
export function setPath(obj, p, value) {
  const keys = assertSafePath(p)
  if (!keys.length || keys[0] === '') throw new Error('路径不能为空')
  let cur = obj
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]
    if (typeof cur[k] !== 'object' || cur[k] === null) assign(cur, k, {})
    cur = cur[k]
  }
  assign(cur, keys[keys.length - 1], value)
}

/** 按点路径读取：getPath(cfg, 'agent.model') → 值或 undefined（非法段按不存在处理） */
export function getPath(obj, p) {
  let cur = obj
  for (const k of String(p ?? '').split('.')) {
    if (cur == null || FORBIDDEN_SEGMENTS.has(k)) return undefined
    cur = cur[k]
  }
  return cur
}

/**
 * 确定性编译器：DiagramSpec → D2 DSL。
 *
 * 不变量：同一 canonical spec 生成逐字节相同的 DSL（数组按声明序拼接、无随机、无时间戳、无 Map 遍历顺序依赖）。
 * 注入面收敛：
 *   - spec id 在编译时全部重写为 n0/n1…/g0/g1…/p0/p1…（序号映射），D2 的 `.`/`:` 嵌套语法不可能被 id 触发；
 *   - label/title/caption 只以双引号字符串字面量出现，`\` 与 `"` 转义；
 *   - 主题色/shape/连线样式全部来自代码内映射表，LLM 无处指定。
 */

/** D2 字符串字面量转义（控制字符已在 spec 层剔除） */
export function d2Escape(s) {
  return '"' + String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

/** 安全 id：spec 层已禁引号/分号/斜杠，这里仍归一为 ASCII 安全形态（双保险） */
export function safeId(prefix, i) {
  return `${prefix}${i}`
}

/** kind → D2 shape 映射（固定表；er/class 类型在节点层覆盖） */
export const KIND_SHAPE = {
  default: 'rectangle', start: 'oval', end: 'circle', decision: 'diamond',
  service: 'rectangle', database: 'cylinder', queue: 'queue', user: 'person',
  agent: 'hexagon', tool: 'package',
}

/**
 * 编译为 D2 DSL。
 * @param {object} spec canonical spec（validateSpec 输出）
 * @param {object} theme THEMES[key]（error 连线色用）
 * @returns {{ dsl: string, nodeCount: number, edgeCount: number }}
 */
export function compileD2(spec, theme) {
  const L = []
  const push = (s) => L.push(s)

  // 方向：D2 只有 down/right（left-right→right）
  push(`direction: ${spec.direction === 'left-right' ? 'right' : 'down'}`)

  // 标题（D2 保留键）+ caption 并入第二行
  const titleText = spec.caption ? `${spec.title}\n${spec.caption}` : spec.title
  push(`title: ${d2Escape(titleText)}`)

  if (spec.type === 'sequence') {
    // D2 原生 sequence_diagram：participants（actor→person shape）+ messages（return→虚线 -->）
    push('seq: {')
    push('  shape: sequence_diagram')
    const pid = new Map()
    spec.participants.forEach((p, i) => {
      const id = safeId('p', i)
      pid.set(p.id, id)
      push(`  ${id}: ${p.kind === 'actor' ? '{ shape: person; label: ' + d2Escape(p.label) + ' }' : d2Escape(p.label)}`)
    })
    for (const m of spec.messages) {
      const arrow = m.kind === 'return' ? '-->' : '->'
      push(`  ${pid.get(m.from)} ${arrow} ${pid.get(m.to)}: ${d2Escape(m.label)}`)
    }
    push('}')
    return { dsl: L.join('\n') + '\n', nodeCount: spec.participants.length, edgeCount: spec.messages.length }
  }

  // 通用图：分组嵌套容器 + 节点 + 连线
  // id 映射（声明序）；nodePath 记录组内节点的限定路径（D2 嵌套作用域——顶层裸 id 引用组内节点
  // 不会报错，而是被 D2 自动创建为同名幽灵节点，连线连错对象。经真实容器验证，必须用 g0.n0 限定名）
  const nid = new Map(spec.nodes.map((n, i) => [n.id, safeId('n', i)]))
  const gid = new Map((spec.groups || []).map((g, i) => [g.id, safeId('g', i)]))
  const nodePath = new Map()

  // 分组树：parent → children（保持声明顺序）
  const groups = spec.groups || []
  const roots = []
  const childrenOf = new Map()
  for (const g of groups) {
    if (g.parent && groups.some((x) => x.id === g.parent)) {
      if (!childrenOf.has(g.parent)) childrenOf.set(g.parent, [])
      childrenOf.get(g.parent).push(g)
    } else roots.push(g)
  }

  const shapeOf = (n) => {
    if (spec.type === 'er') return 'sql_table'
    if (spec.type === 'class') return 'class'
    return KIND_SHAPE[n.kind] || 'rectangle'
  }

  // 递归输出分组块（prefix = 祖先组 id 链）
  const emitGroup = (g, depth, prefix) => {
    const pad = '  '.repeat(depth)
    const id = prefix ? `${prefix}.${gid.get(g.id)}` : gid.get(g.id)
    push(`${pad}${gid.get(g.id)}: {`)
    push(`${pad}  label: ${d2Escape(g.label)}`)
    emitMembers(g.id, depth + 1, id)
    for (const c of childrenOf.get(g.id) || []) emitGroup(c, depth + 1, id)
    push(`${pad}}`)
  }
  const emitMembers = (groupId, depth, prefix) => {
    const pad = '  '.repeat(depth)
    for (const n of spec.nodes) {
      if ((n.group || null) !== groupId) continue
      const id = nid.get(n.id)
      nodePath.set(n.id, prefix ? `${prefix}.${id}` : id)
      // description 不进 D2（避免多行/长文本注入面），语义由 label 承载
      push(`${pad}${id}: { label: ${d2Escape(n.label)}; shape: ${shapeOf(n)} }`)
    }
  }

  // 顶层节点（无分组）→ 各分组树
  emitMembers(null, 0, '')
  for (const g of roots) emitGroup(g, 0, '')

  // 连线（声明序；端点用限定路径，dash 只允许单数值——"1 4" 多值经真实容器验证 400）
  for (const e of spec.edges || []) {
    const arrow = e.kind === 'bidirectional' ? '<->' : '->'
    const label = e.label ? `: ${d2Escape(e.label)}` : ''
    let style = ''
    if (e.kind === 'async') style = ' { style.stroke-dash: 6 }'
    else if (e.kind === 'dependency') style = ' { style.stroke-dash: 2 }'
    else if (e.kind === 'error') style = ` { style.stroke: ${d2Escape(theme.error)}; style.stroke-width: 2 }`
    push(`${nodePath.get(e.from)} ${arrow} ${nodePath.get(e.to)}${label}${style}`)
  }

  return { dsl: L.join('\n') + '\n', nodeCount: spec.nodes.length, edgeCount: (spec.edges || []).length }
}

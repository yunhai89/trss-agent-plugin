/**
 * 确定性编译器：DiagramSpec → Mermaid DSL（本地 beautiful-mermaid 回退引擎用）。
 *
 * 同 compile-d2 的不变量：同一 canonical spec 逐字节稳定；id 重写为序号；label 走实体转义。
 * 主题不进 DSL（颜色由本地渲染的 SVG 后处理按主题注入，见 local-mermaid.js）。
 */

/** Mermaid label 转义：HTML 实体 + `#` 全角化（Mermaid `#xx;` 实体语法的注入面收敛；spec 层已拒 `&#` 形态） */
export function mermaidEscape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/#/g, '＃')
}

/** 编译为 Mermaid DSL。type 支持降级：mindmap/architecture→flowchart 子图。 */
export function compileMermaid(spec) {
  const esc = mermaidEscape
  const dir = spec.direction === 'left-right' ? 'LR' : 'TD'

  if (spec.type === 'sequence') {
    const L = ['sequenceDiagram', 'autonumber']
    const pid = new Map()
    spec.participants.forEach((p, i) => {
      const id = `p${i}`
      pid.set(p.id, id)
      L.push(`participant ${id} as ${esc(p.label)}`)
    })
    for (const m of spec.messages) {
      const arrow = m.kind === 'async' ? '-)' : m.kind === 'return' ? '-->>' : '->>'
      L.push(`${pid.get(m.from)}${arrow}${pid.get(m.to)}: ${esc(m.label)}`)
    }
    return { dsl: L.join('\n') + '\n', nodeCount: spec.participants.length, edgeCount: spec.messages.length }
  }

  if (spec.type === 'state') {
    const L = ['stateDiagram-v2']
    const nid = new Map()
    spec.nodes.forEach((n, i) => { nid.set(n.id, `s${i}`) })
    for (const n of spec.nodes) L.push(`${nid.get(n.id)} : ${esc(n.label)}`)
    for (const e of spec.edges || []) L.push(`${nid.get(e.from)} --> ${nid.get(e.to)}${e.label ? ': ' + esc(e.label) : ''}`)
    return { dsl: L.join('\n') + '\n', nodeCount: spec.nodes.length, edgeCount: (spec.edges || []).length }
  }

  if (spec.type === 'class') {
    const L = ['classDiagram']
    const nid = new Map()
    spec.nodes.forEach((n, i) => { nid.set(n.id, `c${i}`) })
    for (const n of spec.nodes) L.push(`class ${nid.get(n.id)}["${esc(n.label)}"]`)
    for (const e of spec.edges || []) L.push(`${nid.get(e.from)} --> ${nid.get(e.to)}${e.label ? ': ' + esc(e.label) : ''}`)
    return { dsl: L.join('\n') + '\n', nodeCount: spec.nodes.length, edgeCount: (spec.edges || []).length }
  }

  if (spec.type === 'er') {
    const L = ['erDiagram']
    const nid = new Map()
    spec.nodes.forEach((n, i) => { nid.set(n.id, `e${i}`) })
    if (!(spec.edges || []).length) {
      // 无关系的孤立实体：erDiagram 必须至少一条关系语句，退化为自关联显示会误导 → 拒绝由上层处理
      return { dsl: L.join('\n') + '\n', nodeCount: spec.nodes.length, edgeCount: 0, unsupported: 'er 实体图至少需要一条关系连线（Mermaid 后端）' }
    }
    for (const e of spec.edges || []) L.push(`${nid.get(e.from)} ||--o{ ${nid.get(e.to)} : "${esc(e.label || '关联')}"`)
    return { dsl: L.join('\n') + '\n', nodeCount: spec.nodes.length, edgeCount: (spec.edges || []).length }
  }

  // flowchart / architecture / mindmap → flowchart（分组=subgraph，mindmap 用左向子图嵌套表达层级）
  const L = [`flowchart ${dir}`]
  const nid = new Map()
  spec.nodes.forEach((n, i) => { nid.set(n.id, `n${i}`) })
  const groups = spec.groups || []
  const gid = new Map(groups.map((g, i) => [g.id, `g${i}`]))

  // kind → Mermaid 节点形态（error 连线不逐线 linkStyle：链路索引随结构变化不稳定，语义色由主题统一）
  const nodeDef = (n) => {
    const t = esc(n.label)
    switch (n.kind) {
      case 'start': case 'end': return `([${t}])`
      case 'decision': return `{${t}}`
      case 'database': return `[(${t})]`
      case 'queue': case 'agent': case 'tool': return `[[${t}]]`
      case 'user': return `(${t})`
      default: return `[${t}]`
    }
  }

  const groupedNodes = new Set(spec.nodes.filter((n) => n.group && gid.has(n.group)).map((n) => n.id))
  // 顶层节点
  for (const n of spec.nodes) if (!groupedNodes.has(n.id)) L.push(`${nid.get(n.id)}${nodeDef(n)}`)
  // 分组（含嵌套：Mermaid 嵌套 subgraph 需物理包含，递归展开）
  const childrenOf = new Map()
  for (const g of groups) {
    if (g.parent && gid.has(g.parent)) {
      if (!childrenOf.has(g.parent)) childrenOf.set(g.parent, [])
      childrenOf.get(g.parent).push(g)
    }
  }
  const emitGroup = (g, depth) => {
    L.push(`${'  '.repeat(depth)}subgraph ${gid.get(g.id)}["${esc(g.label)}"]`)
    for (const n of spec.nodes) if (n.group === g.id) L.push(`${'  '.repeat(depth + 1)}${nid.get(n.id)}${nodeDef(n)}`)
    for (const c of childrenOf.get(g.id) || []) emitGroup(c, depth + 1)
    L.push(`${'  '.repeat(depth)}end`)
  }
  for (const g of groups) if (!(g.parent && gid.has(g.parent))) emitGroup(g, 0)

  for (const e of spec.edges || []) {
    const arrow = e.kind === 'async' || e.kind === 'dependency' ? '-.->' : e.kind === 'bidirectional' ? '<-->' : '-->'
    const label = e.label ? `|${esc(e.label)}|` : ''
    L.push(`${nid.get(e.from)} ${arrow}${label ? ' ' + label : ''} ${nid.get(e.to)}`)
  }
  return { dsl: L.join('\n') + '\n', nodeCount: spec.nodes.length, edgeCount: (spec.edges || []).length }
}

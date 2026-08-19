/**
 * 离线自检 —— diagram 渲染核心（spec 校验 / 确定性编译 / 本地渲染 / 栅格化 / 缓存 / 取消 / TTL）。
 * 运行：node model/diagram/test.mjs   （不依赖 Kroki 容器：本地 beautiful-mermaid 引擎真实渲染；
 *         Kroki HTTP 层专项见 kroki.test.mjs，真实容器集成见 kroki.integration.test.mjs）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { validateSpec, stripControl } from './spec.js'
import { compileD2 } from './compile-d2.js'
import { compileMermaid } from './compile-mermaid.js'
import { checkSvg } from './svg-check.js'
import { expandSvgCss } from './svg-css.js'
import { computeTargetSize, rasterizeSvg } from './raster.js'
import { TempDir } from './tempdir.js'
import { DiagramCache } from './cache.js'
import { DiagramService, summaryOf } from './index.js'
import { THEMES } from './themes.js'

let passed = 0, failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { ok(a === b, `${m}（实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack?.split('\n').slice(0, 3).join('\n')) } }

const FLOW = {
  type: 'flowchart', title: '主 Agent 工作流',
  nodes: [
    { id: 'user', label: '用户请求', kind: 'user' },
    { id: 'agent', label: '主 Agent', kind: 'agent' },
    { id: 'decide', label: '需要工具?', kind: 'decision' },
    { id: 'search', label: 'web_search', kind: 'tool' },
    { id: 'reply', label: '最终回复', kind: 'end' },
  ],
  edges: [
    { from: 'user', to: 'agent', label: '提问' },
    { from: 'agent', to: 'decide' },
    { from: 'decide', to: 'search', label: '是' },
    { from: 'search', to: 'reply', label: '结果' },
    { from: 'decide', to: 'reply', label: '否', kind: 'error' },
  ],
}
const SEQ = {
  type: 'sequence', title: '工具调用时序',
  participants: [
    { id: 'u', label: '用户', kind: 'actor' },
    { id: 'a', label: '主 Agent' },
    { id: 't', label: '搜索工具', kind: 'service' },
  ],
  messages: [
    { from: 'a', to: 't', label: '检索请求', order: 2 },
    { from: 'u', to: 'a', label: '帮我查资料', order: 1 },
    { from: 't', to: 'a', label: '结果列表', kind: 'return', order: 3 },
  ],
}

const svcCfg = (over = {}) => ({ renderer: 'none', fallbackRenderer: 'beautiful-mermaid', ...over })
const mkSvc = (over = {}) => new DiagramService(svcCfg(over), { logger: () => {} })
const TMPROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-test-'))
// 临时目录隔离：让本测试的 TempDir 不污染真实 data/diagram
const svcIso = new DiagramService({ ...svcCfg() }, { logger: () => {} })
svcIso.temp.dir = path.join(TMPROOT, 'dg'); fs.mkdirSync(svcIso.temp.dir, { recursive: true })

// ─── 1. Schema 校验 ───
await test('Schema：正常 flowchart / sequence 通过并产出 canonical spec', async () => {
  const a = validateSpec(FLOW)
  ok(a.ok, 'flowchart 通过')
  eq(a.spec.type, 'flowchart', 'type 保留')
  eq(a.spec.direction, 'top-down', 'flowchart 默认 top-down')
  eq(a.spec.nodes[0].kind, 'user', 'kind 保留')
  const b = validateSpec(SEQ)
  ok(b.ok, 'sequence 通过')
  eq(b.spec.messages[0].label, '帮我查资料', 'order=1 排到首位')
  eq(b.spec.messages[2].kind, 'return', 'return kind 保留')
})

await test('Schema：缺 title / 重复 id / 悬空 edge / 空图 各自拒绝', async () => {
  const noTitle = validateSpec({ ...FLOW, title: undefined })
  ok(!noTitle.ok && noTitle.errorClass === 'invalid_arguments', '缺 title 拒绝')
  ok(/title/.test(noTitle.field || ''), 'field 指向 title')
  const dup = validateSpec({ ...FLOW, nodes: [...FLOW.nodes, { id: 'user', label: '重复' }] })
  ok(!dup.ok && /重复/.test(dup.message), '重复 node id 拒绝：' + dup.message)
  const dangling = validateSpec({ ...FLOW, edges: [...FLOW.edges, { from: 'user', to: 'node-x' }] })
  ok(!dangling.ok && /node-x/.test(dangling.message), '悬空 edge target 拒绝')
  eq(dangling.field, 'edges[5].to', 'field 精确到 edges[5].to')
  const empty = validateSpec({ type: 'state', title: '空图' })
  ok(!empty.ok && /至少 1 个 node/.test(empty.message), '空图拒绝')
  const seqNoParticipants = validateSpec({ type: 'sequence', title: 'x', messages: [{ from: 'a', to: 'b', label: 'hi' }] })
  ok(!seqNoParticipants.ok, 'sequence 缺参与者拒绝')
  const seqDangling = validateSpec({ ...SEQ, messages: [...SEQ.messages, { from: 'u', to: 'ghost', label: 'x', order: 9 }] })
  ok(!seqDangling.ok && /ghost/.test(seqDangling.message), 'sequence 悬空参与者拒绝')
})

await test('Schema：数量/长度上限收紧生效', async () => {
  const many = { type: 'flowchart', title: 'x', nodes: Array.from({ length: 6 }, (_, i) => ({ id: 'n' + i, label: 'N' + i })) }
  ok(validateSpec(many, { maxNodes: 5 }).ok === false, 'config 收紧 maxNodes=5 时 6 节点拒绝')
  ok(validateSpec(many).ok === true, '默认上限 50 时 6 节点通过')
  const longLabel = { type: 'flowchart', title: 'x', nodes: [{ id: 'n0', label: '长'.repeat(81) }] }
  const r = validateSpec(longLabel)
  ok(!r.ok && /label/.test(r.message), '81 字 label 拒绝')
})

await test('Schema：group parent 循环 / 悬空 group 拒绝', async () => {
  const cycle = validateSpec({
    type: 'flowchart', title: 'x',
    nodes: [{ id: 'a', label: 'A', group: 'g1' }],
    groups: [{ id: 'g1', label: 'G1', parent: 'g2' }, { id: 'g2', label: 'G2', parent: 'g1' }],
  })
  ok(!cycle.ok && /循环/.test(cycle.message), 'parent 循环拒绝：' + cycle.message)
  const danglingGroup = validateSpec({ ...FLOW, nodes: FLOW.nodes.map((n) => ({ ...n, group: 'gX' })), groups: [{ id: 'g1', label: 'G1' }] })
  ok(!danglingGroup.ok && /gX/.test(danglingGroup.message), 'node.group 悬空拒绝')
})

await test('Schema：注入面——HTML/script/URL/data:/路径穿越/未知字段 全拒', async () => {
  const injects = [
    [{ ...FLOW, title: '<script>alert(1)</script>' }, 'title'],
    [{ ...FLOW, nodes: [...FLOW.nodes.slice(0, 1), { id: 'x', label: '<img src=x onerror=alert(1)>' }] }, 'label HTML'],
    [{ ...FLOW, title: '参见 https://evil.example.com/x' }, '外部 URL'],
    [{ ...FLOW, title: 'data:text/html;base64,xxx' }, 'data: URL'],
    [{ ...FLOW, nodes: [{ id: '../../etc/passwd', label: '路径穿越' }] }, '路径穿越 id'],
    [{ ...FLOW, nodes: [{ id: 'a"b;c', label: '引号分号' }] }, 'DSL 逃逸字符 id'],
    [{ ...FLOW, endpoint: 'http://evil:8000' }, '未知字段 endpoint'],
    [{ ...FLOW, svg: '<svg onload=1>' }, '未知字段 svg'],
  ]
  for (const [spec, name] of injects) {
    const r = validateSpec(spec)
    ok(!r.ok, `${name} 拒绝` + (r.ok ? '' : `（${(r.message || '').slice(0, 50)}）`))
  }
})

await test('Schema：特殊字符 / 中文 / Emoji / 控制字符', async () => {
  ok(stripControl('a\x00b\x1Fc\x7Fd') === 'abcd', '控制字符剔除')
  const r = validateSpec({
    type: 'flowchart', title: '特殊字符 "引号" 与 {括号} 和 #123 测试',
    nodes: [{ id: 'ok', label: '节点 "A" & B {C} | D 🎉 中文' }],
  })
  ok(r.ok, '特殊字符+Emoji 合法（label 层允许，转义层处理）：' + (r.ok ? '' : r.message))
  const emoji = validateSpec({ type: 'flowchart', title: '🎉 表情标题', nodes: [{ id: 'e', label: '🚀 启动' }] })
  ok(emoji.ok, 'Emoji 通过')
})

// ─── 2. 确定性编译 ───
await test('编译：同一 spec 两次编译逐字节相同（D2 与 Mermaid）', async () => {
  const v = validateSpec(FLOW)
  const d1 = compileD2(v.spec, THEMES['paper-blue']); const d2 = compileD2(v.spec, THEMES['paper-blue'])
  eq(d1.dsl, d2.dsl, 'D2 DSL 逐字节稳定')
  const m1 = compileMermaid(v.spec); const m2 = compileMermaid(v.spec)
  eq(m1.dsl, m2.dsl, 'Mermaid DSL 逐字节稳定')
})

await test('编译：对象属性顺序不影响输出（canonical 化）', async () => {
  const shuffled = JSON.parse(JSON.stringify(FLOW))
  shuffled.nodes = shuffled.nodes.map((n) => Object.fromEntries(Object.entries(n).reverse()))
  const a = compileD2(validateSpec(FLOW).spec, THEMES.technical)
  const b = compileD2(validateSpec(shuffled).spec, THEMES.technical)
  eq(a.dsl, b.dsl, '字段乱序 → 相同 DSL')
})

await test('编译：转义——引号/反斜杠不破坏 DSL；HTML 标签在 spec 层拒绝', async () => {
  const v = validateSpec({
    type: 'flowchart', title: '转义测试',
    nodes: [{ id: 'a', label: '含"双引号"与\\反斜杠' }, { id: 'b', label: '普通节点' }],
  })
  ok(v.ok, 'spec 通过（label 允许引号）')
  const { dsl } = compileD2(v.spec, THEMES.technical)
  ok(dsl.includes('\\"双引号\\"'), 'D2 引号转义')
  const m = compileMermaid(v.spec)
  ok(m.dsl.includes('&quot;双引号&quot;'), 'Mermaid 引号实体转义')
  // label 含 HTML 标签 → spec 层拒绝（不进入转义层）
  const htmlLabel = validateSpec({ type: 'flowchart', title: 'x', nodes: [{ id: 'a', label: '<b>加粗</b>' }] })
  ok(!htmlLabel.ok, 'label 含 HTML 标签在 spec 层拒绝')
})

await test('编译：节点/连线/分组数量与 sequence 顺序', async () => {
  const spec = {
    type: 'architecture', title: '分组架构', direction: 'left-right',
    groups: [{ id: 'front', label: '前端' }, { id: 'back', label: '后端' }, { id: 'back-db', label: '数据库层', parent: 'back' }],
    nodes: [
      { id: 'web', label: 'Web', group: 'front' },
      { id: 'api', label: 'API', group: 'back' },
      { id: 'db', label: 'MySQL', kind: 'database', group: 'back-db' },
    ],
    edges: [
      { from: 'web', to: 'api', label: 'HTTPS' },
      { from: 'api', to: 'db', kind: 'dependency' },
    ],
  }
  const v = validateSpec(spec)
  ok(v.ok, 'architecture spec 通过')
  const d = compileD2(v.spec, THEMES.technical)
  eq((d.dsl.match(/shape: /g) || []).length, 3, 'D2 节点 shape 数=3')
  eq((d.dsl.match(/ -> /g) || []).length, 2, 'D2 连线数=2')
  ok(d.dsl.includes('direction: right'), 'left-right → direction: right')
  ok(/g\d+: \{[\s\S]*g\d+: \{/.test(d.dsl), '分组嵌套（back 内含 back-db）')
  const s = compileD2(validateSpec(SEQ).spec, THEMES.technical)
  ok(s.dsl.includes('shape: sequence_diagram'), 'sequence 用原生 shape')
  ok(s.dsl.indexOf('帮我查资料') < s.dsl.indexOf('检索请求'), 'sequence 按 order 排序')
  const m = compileMermaid(validateSpec(SEQ).spec)
  ok(m.dsl.includes('autonumber'), 'Mermaid sequence autonumber')
})

await test('编译：id 重写——spec 原始 id 不出现在 DSL 标识位', async () => {
  const v = validateSpec({ ...FLOW, nodes: FLOW.nodes.map((n) => ({ ...n, id: 'weird.id:with:syntax' + n.id })) , edges: [] })
  const { dsl } = compileD2(v.spec, THEMES.technical)
  ok(!/weird\.id/.test(dsl), '原始 id（含 D2 语法字符）不出现')
})

// ─── 3. SVG 检查与后处理 ───
await test('SVG 检查：合法通过 / 各类恶意内容拒绝', async () => {
  ok(checkSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text>OK</text></svg>').ok, '合法 SVG（xmlns 豁免）')
  ok(checkSvg('<svg viewBox="0 0 10 10"><script>1</script></svg>').ok === false, 'script 拒绝')
  ok(checkSvg('<svg viewBox="0 0 10 10"><image href="https://e/x.png"/></svg>').ok === false, 'image+外部 href 拒绝')
  ok(checkSvg('<svg viewBox="0 0 10 10"><a href="//evil/x"><text>x</text></a></svg>').ok === false, '协议相对 // 拒绝')
  ok(checkSvg('<svg viewBox="0 0 10 10" onload="x()"><text>y</text></svg>').ok === false, '事件属性拒绝')
  ok(checkSvg('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg viewBox="0 0 1 1"/>').ok === false, 'DOCTYPE/实体拒绝')
  ok(checkSvg('<html><body>err</body></html>').ok === false, 'HTML 错误页伪装拒绝')
  ok(checkSvg('<svg viewBox="0 0 10 10"><style>@import url("https://e/x.css")</style></svg>').ok === false, '@import 拒绝')
  ok(checkSvg('<svg viewBox="0 0 10 10"><foreignObject width="1" height="1"/></svg>').ok === false, 'foreignObject 拒绝')
  const big = checkSvg('<svg viewBox="0 0 1 1">' + 'x'.repeat(5 * 1024 * 1024) + '</svg>', { maxBytes: 1024 })
  ok(big.ok === false && big.errorClass === 'output_too_large', '超 maxBytes → output_too_large')
  const dims = checkSvg('<svg xmlns="http://www.w3.org/2000/svg" width="800.5" height="600" viewBox="0 0 100 75"/>')
  eq(dims.width, 800.5, '尺寸解析 width')
  eq(dims.height, 600, '尺寸解析 height')
})

await test('SVG 后处理：@import 剥除 / var() 展开 / color-mix 计算', async () => {
  const src = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" style="--bg:#FFFFFF;--fg:#27272A;background:var(--bg)">
<style>@import url('https://fonts.googleapis.com/css2?family=Inter'); text { font-family: 'Inter', system-ui; }
svg { --_text: var(--fg); --_line: color-mix(in srgb, var(--fg) 50%, var(--bg)); }</style>
<text fill="var(--_text)" stroke="var(--_line)">中文</text></svg>`
  const { svg, unresolved } = expandSvgCss(src, { bg: '#0F172A', fg: '#E2E8F0' }, 'Noto Sans CJK SC')
  ok(!svg.includes('@import'), '@import 已剥除')
  ok(!svg.includes('fonts.googleapis'), '外链字体域名已移除')
  ok(svg.includes("font-family: 'Noto Sans CJK SC'"), '字体已替换')
  ok(!/var\(--/.test(svg), 'var() 全部展开')
  ok(unresolved === false, '无未解析变量')
  ok(svg.includes('--bg:#0F172A') || svg.includes('--bg: #0F172A') || svg.includes('#E2E8F0'), '主题变量已注入')
  ok(!svg.includes('color-mix'), 'color-mix 已计算为具体色值')
  ok(checkSvg(svg).ok, '后处理产物通过安全检查')
})

await test('SVG 后处理：循环 var() 引用不死循环', async () => {
  const src = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><style>svg { --a: var(--b); --b: var(--a); }</style><text fill="var(--a)">x</text></svg>`
  const t0 = Date.now()
  const { svg } = expandSvgCss(src)
  ok(Date.now() - t0 < 2000, '循环引用在迭代上限内返回')
  ok(typeof svg === 'string', '输出仍为字符串')
})

// ─── 4. 尺寸策略 ───
await test('尺寸：目标宽/最大宽/最大高/最大像素钳制', async () => {
  eq(computeTargetSize(800, 400, { targetWidth: 1600 }).width, 1600, '小图放大到 1600')
  const tall = computeTargetSize(400, 4000, { targetWidth: 1600, maxHeight: 5000 })
  eq(tall.height, 5000, '超高图钳到 maxHeight')
  ok(tall.width <= 1600, '宽随比缩')
  const huge = computeTargetSize(2000, 4000, { targetWidth: 1600, maxWidth: 2000, maxHeight: 5000, maxPixels: 1_000_000 })
  ok(huge.width * huge.height <= 1_000_000, '像素上限生效')
  eq(computeTargetSize(null, null, {}).width, 1600, '未知原始尺寸回退目标宽')
})

// ─── 5. 渲染（本地引擎真实栅格化） ───
const renderOk = async (spec, name, expect = {}) => {
  const r = await svcIso.render(spec, { toolCallId: 't-' + name })
  if (!r.ok) { ok(false, `${name} 渲染失败：${r.errorClass} ${r.message}`); return null }
  ok(r.ok, `${name} 渲染成功`)
  ok(r.path.startsWith(svcIso.temp.dir), `${name} 输出位于受控目录`)
  const buf = fs.readFileSync(r.path)
  ok(buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50, `${name} PNG 魔数正确`)
  ok(buf.length === r.bytes && buf.length > 1000, `${name} 字节数一致且非空（${buf.length}B）`)
  ok(buf.length <= 8_388_608, `${name} 未超输出上限`)
  ok(r.width <= 2000 && r.height <= 5000, `${name} 尺寸受控（${r.width}x${r.height}）`)
  if (expect.minColors) {
    const { count } = await pngColorStats(r.path)
    ok(count >= expect.minColors, `${name} 色彩多样性 ≥${expect.minColors}（实际 ${count}，防单色剪影/方框）`)
  }
  return r
}

async function pngColorStats(file) {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas')
  const img = await loadImage(file)
  const c = createCanvas(img.width, img.height); const g = c.getContext('2d')
  g.drawImage(img, 0, 0)
  const d = g.getImageData(0, 0, img.width, img.height).data
  const colors = new Set(); let dark = 0
  for (let i = 0; i < d.length; i += 4) {
    const [r, gg, b, a] = [d[i], d[i + 1], d[i + 2], d[i + 3]]
    if (a === 0) continue
    colors.add((r >> 4) + ',' + (gg >> 4) + ',' + (b >> 4))
    if (r < 90 && gg < 90 && b < 90) dark++
  }
  return { count: colors.size, dark, w: img.width, h: img.height }
}

await test('渲染：中文流程图（含深色文字像素 → 中文非空白）', async () => {
  const r = await renderOk(FLOW, '中文流程图', { minColors: 8 })
  if (r) {
    const { dark } = await pngColorStats(r.path)
    ok(dark > 500, `中文文字渲染为深色像素（${dark}px，防 □□ 方框/空白）`)
  }
})

await test('渲染：复杂架构图（分组嵌套 + database 形态 + 依赖线）', async () => {
  await renderOk({
    type: 'architecture', title: '插件系统架构', direction: 'left-right',
    groups: [
      { id: 'chat', label: '会话层' }, { id: 'agent', label: 'Agent 层' },
      { id: 'store', label: '存储层', parent: 'agent' },
    ],
    nodes: [
      { id: 'qq', label: 'QQ/NapCat', group: 'chat', kind: 'user' },
      { id: 'yunzai', label: 'TRSS-Yunzai', group: 'chat' },
      { id: 'loop', label: 'Agent Loop', group: 'agent', kind: 'agent' },
      { id: 'tools', label: 'ToolRegistry', group: 'agent', kind: 'tool' },
      { id: 'kv', label: 'Redis/KV', group: 'store', kind: 'database' },
      { id: 'md', label: 'MemoryStore', group: 'store', kind: 'database' },
      { id: 'llm', label: 'LLM Provider', kind: 'service' },
    ],
    edges: [
      { from: 'qq', to: 'yunzai', label: '消息' },
      { from: 'yunzai', to: 'loop', label: '#ai' },
      { from: 'loop', to: 'tools', label: 'tool_call' },
      { from: 'tools', to: 'loop', label: 'tool_result', kind: 'async' },
      { from: 'loop', to: 'llm', label: '推理' },
      { from: 'loop', to: 'kv', kind: 'dependency' },
      { from: 'loop', to: 'md', kind: 'dependency' },
    ],
  }, '架构图', { minColors: 8 })
})

await test('渲染：时序图 / 状态图 / 类图 / 关系图 / 思维导图', async () => {
  await renderOk(SEQ, '时序图', { minColors: 6 })
  await renderOk({
    type: 'state', title: '任务状态机',
    nodes: [
      { id: 'idle', label: '空闲', kind: 'start' },
      { id: 'run', label: '执行中' },
      { id: 'wait', label: '等待审批' },
      { id: 'done', label: '完成', kind: 'end' },
      { id: 'fail', label: '失败', kind: 'end' },
    ],
    edges: [
      { from: 'idle', to: 'run', label: '触发' },
      { from: 'run', to: 'wait', label: '需确认' },
      { from: 'wait', to: 'run', label: '批准' },
      { from: 'run', to: 'done', label: '成功' },
      { from: 'run', to: 'fail', label: '异常', kind: 'error' },
    ],
  }, '状态图（有环 wait→run→wait）', { minColors: 6 })
  await renderOk({
    type: 'class', title: '类图',
    nodes: [{ id: 'agent', label: 'Agent' }, { id: 'provider', label: 'Provider' }, { id: 'registry', label: 'ToolRegistry' }],
    edges: [{ from: 'agent', to: 'provider', label: '使用' }, { from: 'agent', to: 'registry', label: '持有' }],
  }, '类图')
  await renderOk({
    type: 'er', title: '关系图',
    nodes: [{ id: 'user', label: '用户', kind: 'user' }, { id: 'msg', label: '消息' }, { id: 'session', label: '会话' }],
    edges: [{ from: 'user', to: 'session', label: '拥有' }, { from: 'session', to: 'msg', label: '包含' }],
  }, 'ER 图')
  await renderOk({
    type: 'mindmap', title: '功能思维导图', direction: 'left-right',
    groups: [{ id: 'core', label: '核心' }, { id: 'ext', label: '扩展' }],
    nodes: [
      { id: 'root', label: 'Agent 插件' },
      { id: 'chat', label: '对话', group: 'core' },
      { id: 'mem', label: '记忆', group: 'core' },
      { id: 'mcp', label: 'MCP', group: 'ext' },
      { id: 'evo', label: '工具进化', group: 'ext' },
    ],
    edges: [{ from: 'root', to: 'chat', label: '包含' }, { from: 'root', to: 'mcp', label: '可插拔' }],
  }, '思维导图')
})

await test('渲染：midnight 深色主题（背景非白）', async () => {
  const r = await renderOk({ ...FLOW, theme: 'midnight' }, 'midnight', { minColors: 6 })
  if (r) {
    const { createCanvas, loadImage } = await import('@napi-rs/canvas')
    const img = await loadImage(r.path)
    const c = createCanvas(img.width, img.height); const g = c.getContext('2d')
    g.drawImage(img, 0, 0)
    const px = g.getImageData(Math.floor(img.width / 2), 5, 1, 1).data // 顶部边缘≈背景
    ok(px[2] > px[0] && px[2] > 40 && px[0] < 60, `深色背景像素偏蓝黑（rgba(${px.join(',')}）`)
  }
})

await test('渲染：超长标签（80 字上限内）不崩溃', async () => {
  await renderOk({
    type: 'flowchart', title: '长标签',
    nodes: [{ id: 'a', label: '这是一个非常长的节点标签用于测试文本换行与宽度计算的行为是否正常稳定不溢出画面边界情况测试' }, { id: 'b', label: 'B' }],
    edges: [{ from: 'a', to: 'b', label: '这条连线的说明文字同样很长很长很长很长用来测试连线标签的渲染稳定性' }],
  }, '超长标签')
})

await test('渲染：SVG 输出模式（可编辑源文件）', async () => {
  const r = await svcIso.render({ ...FLOW, output: 'svg' }, { toolCallId: 't-svg' })
  ok(r.ok && r.format === 'svg' && r.path.endsWith('.svg'), 'svg 格式输出')
  if (r.ok) {
    const txt = fs.readFileSync(r.path, 'utf8')
    ok(txt.startsWith('<svg') || txt.includes('<svg'), 'svg 文件为 SVG 内容')
    ok(!txt.includes('@import') && !txt.includes('var(--'), 'svg 输出已展开变量/无外链')
  }
})

await test('渲染：错误分类与失败不缓存', async () => {
  const r = await svcIso.render({ type: 'flowchart', title: 'x', nodes: [{ id: 'a', label: 'A' }] }, { toolCallId: 't-err' })
  ok(r.ok, '合法 spec 渲染成功（对照）')
  const bad = await svcIso.render({ type: 'flowchart' }, { toolCallId: 't-err2' })
  ok(!bad.ok && bad.errorClass === 'invalid_arguments', '非法 spec → invalid_arguments')
  ok(typeof bad.message === 'string' && !/at .*\(/.test(bad.message), '错误无堆栈泄漏')
  const stats = svcIso.cache.stats
  const fails = [...svcIso.cache.map.values()].filter((e) => !e.result.ok).length
  eq(fails, 0, '失败结果未写缓存')
})

await test('渲染：取消——signal 已中止时不渲染不落盘', async () => {
  const before = fs.readdirSync(svcIso.temp.dir).length
  const ctl = new AbortController()
  ctl.abort()
  const r = await svcIso.render({ ...FLOW, title: '取消测试' }, { signal: ctl.signal, toolCallId: 't-cancel' })
  ok(!r.ok && r.errorClass === 'cancelled', '已取消 → cancelled 终态：' + (r.errorClass || ''))
  const after = fs.readdirSync(svcIso.temp.dir).length
  eq(after, before, '取消后无新文件')
})

await test('缓存：相同输入命中 / 不同主题 miss / singleflight 合并', async () => {
  const s1 = new DiagramService({ ...svcCfg() }, { logger: () => {} })
  s1.temp.dir = path.join(TMPROOT, 'cache'); fs.mkdirSync(s1.temp.dir, { recursive: true })
  const a = await s1.render(FLOW, { toolCallId: 'c1' })
  ok(a.ok && a.cacheHit !== true, '首次渲染 miss')
  const b = await s1.render(FLOW, { toolCallId: 'c2' })
  ok(b.ok && b.cacheHit === true && b.path === a.path, '相同输入复用结果')
  const c = await s1.render({ ...FLOW, theme: 'technical' }, { toolCallId: 'c3' })
  ok(c.ok && c.cacheHit !== true, '不同主题 miss')
  // singleflight：并发两个相同请求，只有一个执行渲染
  const inflightBefore = s1.cache.stats.inflightJoin
  await Promise.all([s1.render({ ...FLOW, title: '并发测试' }, { toolCallId: 'c4' }), s1.render({ ...FLOW, title: '并发测试' }, { toolCallId: 'c5' })])
  ok(s1.cache.stats.inflightJoin > inflightBefore, 'singleflight 合并在途请求')
  // 文件被清理后缓存失效
  fs.unlinkSync(b.path)
  const d = await s1.render(FLOW, { toolCallId: 'c6' })
  ok(d.ok && d.cacheHit !== true, '临时文件被清理后缓存失效（重新渲染）')
})

// ─── 6. 临时目录 ───
await test('临时目录：TTL 清理只删本目录内 dg-* 文件', async () => {
  const dir = new TempDir({ dir: path.join(TMPROOT, 'ttl'), ttlMinutes: 1 })
  dir.write('dg-0123456789abcdef-706e.png', Buffer.from('x'))
  const keep = path.join(dir.dir, 'notadiagram.txt')
  fs.writeFileSync(keep, 'keep me')
  fs.writeFileSync(path.join(dir.dir, 'dg-0123456789abcdef-706e.png.tmp'), 'x') // 写崩残留
  // mtime 拨回 2 分钟前（utimes 的数字参数按秒解释，必须传 Date）
  const old = new Date(Date.now() - 2 * 60_000)
  fs.utimesSync(path.join(dir.dir, 'dg-0123456789abcdef-706e.png'), old, old)
  fs.utimesSync(path.join(dir.dir, 'dg-0123456789abcdef-706e.png.tmp'), old, old)
  const removed = dir.sweep()
  eq(removed, 2, '超 TTL 的 dg-* 与 .tmp 残留被清理')
  ok(fs.existsSync(keep), '非 dg-* 文件不动')
  ok(!dir.sweep(), '再扫无残留')
})

await test('临时目录：非法文件名拒绝（路径穿越）', async () => {
  const dir = new TempDir({ dir: path.join(TMPROOT, 'safe') })
  let threw = false
  try { dir.resolve('../../etc/passwd') } catch { threw = true }
  ok(threw, '路径穿越文件名抛错')
})

// ─── 7. 摘要 ───
await test('摘要生成', async () => {
  ok(/5 个节点、5 条连接/.test(summaryOf(validateSpec(FLOW).spec)), 'flowchart 摘要')
  ok(/3 个参与者和 3 条消息/.test(summaryOf(validateSpec(SEQ).spec)), 'sequence 摘要')
})

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exit(failed ? 1 : 0)

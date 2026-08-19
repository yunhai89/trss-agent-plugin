/**
 * 真实自托管 Kroki 容器集成测试 —— 需显式环境开关：KROKI_INTEGRATION=1 node model/diagram/kroki.integration.test.mjs
 * 默认（未设开关/容器不可达）输出 SKIPPED 且 exit 0——绝不宣称未运行的测试通过。
 *
 * 覆盖任务 §19.16.15：中文架构图、中文流程图、D2 sequence_diagram、D2 sql_table ER 图、sketch 手绘、midnight 深色；
 * 验证 Kroki SVG 经 resvg 得到合法 PNG、中文非空白/方框（暗色墨迹像素统计）。
 * 测试只连接 KROKI_ENDPOINT（默认 http://127.0.0.1:8000，自托管），绝不访问公共 Kroki。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ENDPOINT = process.env.KROKI_ENDPOINT || 'http://127.0.0.1:8000'

if (process.env.KROKI_INTEGRATION !== '1') {
  console.log('SKIPPED：未设置 KROKI_INTEGRATION=1（真实容器集成测试未运行；HTTP mock 全覆盖见 kroki.test.mjs）')
  console.log('通过 0，失败 0')
  process.exit(0)
}

const { DiagramService } = await import('./index.js')

let passed = 0, failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e) } }

// 容器可达性预检（不可达则 SKIPPED，不算失败——环境缺失≠代码失败）
const alive = await fetch(ENDPOINT + '/health').then((r) => r.ok).catch(() => false)
if (!alive) {
  console.log(`SKIPPED：Kroki 容器不可达（${ENDPOINT}）。请先 docker compose -f docs/deploy/kroki-compose.yaml up -d`)
  console.log('通过 0，失败 0')
  process.exit(0)
}

const TMPROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'kroki-int-'))
const mkSvc = (over = {}) => {
  const svc = new DiagramService({
    renderer: 'kroki', fallbackRenderer: 'none',
    kroki: { endpoint: ENDPOINT, connectTimeoutMs: 2000, requestTimeoutMs: 15000, circuitBreaker: { enabled: false } },
    ...over,
  }, { logger: () => {} })
  svc.temp.dir = path.join(TMPROOT, 'out-' + Math.random().toString(36).slice(2, 6)); fs.mkdirSync(svc.temp.dir, { recursive: true })
  return svc
}

async function pngStats(file) {
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
  return { w: img.width, h: img.height, colors: colors.size, dark }
}

const mustRender = async (spec, name, minColors = 6) => {
  const r = await mkSvc().render(spec, { toolCallId: 'it-' + name })
  if (!r.ok) { ok(false, `${name} 渲染失败：${r.errorClass} ${r.message}`); return null }
  ok(r.engine === 'kroki-d2', `${name} engine=kroki-d2`)
  ok(r.width > 0 && r.height > 0, `${name} 尺寸 ${r.width}x${r.height}`)
  const buf = fs.readFileSync(r.path)
  ok(buf[0] === 0x89 && buf[1] === 0x50, `${name} PNG 魔数`)
  const st = await pngStats(r.path)
  ok(st.colors >= minColors, `${name} 色彩多样性（${st.colors} 色，防单色剪影）`)
  ok(st.dark > 300, `${name} 中文墨迹像素 ${st.dark}px（非空白/方框）`)
  return r
}

await test('真实 Kroki：中文流程图', async () => {
  await mustRender({
    type: 'flowchart', title: '主 Agent 工作流',
    nodes: [
      { id: 'user', label: '用户请求', kind: 'user' },
      { id: 'agent', label: '主 Agent', kind: 'agent' },
      { id: 'd', label: '需要工具?', kind: 'decision' },
      { id: 't', label: '调用工具', kind: 'tool' },
      { id: 'r', label: '最终回复', kind: 'end' },
    ],
    edges: [{ from: 'user', to: 'agent', label: '提问' }, { from: 'agent', to: 'd' }, { from: 'd', to: 't', label: '是' }, { from: 't', to: 'r' }, { from: 'd', to: 'r', label: '否', kind: 'error' }],
  }, '中文流程图')
})

await test('真实 Kroki：中文架构图（嵌套分组）', async () => {
  await mustRender({
    type: 'architecture', title: '插件系统架构', direction: 'left-right',
    groups: [{ id: 'chat', label: '会话层' }, { id: 'agent', label: 'Agent 层' }, { id: 'store', label: '存储层', parent: 'agent' }],
    nodes: [
      { id: 'qq', label: 'QQ 适配器', group: 'chat' },
      { id: 'loop', label: 'ReAct 循环', group: 'agent', kind: 'agent' },
      { id: 'tools', label: 'ToolRegistry', group: 'agent', kind: 'tool' },
      { id: 'kv', label: 'Redis KV', group: 'store', kind: 'database' },
    ],
    edges: [{ from: 'qq', to: 'loop', label: '消息' }, { from: 'loop', to: 'tools' }, { from: 'tools', to: 'kv', kind: 'dependency' }],
  }, '中文架构图')
})

await test('真实 Kroki：D2 sequence_diagram', async () => {
  await mustRender({
    type: 'sequence', title: '工具调用时序',
    participants: [
      { id: 'u', label: '用户', kind: 'actor' },
      { id: 'a', label: '主 Agent' },
      { id: 't', label: 'diagram_render', kind: 'service' },
    ],
    messages: [
      { from: 'u', to: 'a', label: '画个流程图', order: 1 },
      { from: 'a', to: 't', label: 'DiagramSpec', order: 2 },
      { from: 't', to: 'a', label: 'PNG 引用', kind: 'return', order: 3 },
      { from: 'a', to: 'u', label: '发送示意图', order: 4 },
    ],
  }, '时序图')
})

await test('真实 Kroki：D2 sql_table ER 图', async () => {
  await mustRender({
    type: 'er', title: '数据关系',
    nodes: [
      { id: 'user', label: '用户', kind: 'database' },
      { id: 'session', label: '会话', kind: 'database' },
      { id: 'msg', label: '消息', kind: 'database' },
    ],
    edges: [{ from: 'user', to: 'session', label: '拥有' }, { from: 'session', to: 'msg', label: '包含' }],
  }, 'ER 图')
})

await test('真实 Kroki：sketch 手绘主题', async () => {
  await mustRender({
    type: 'flowchart', theme: 'sketch', title: '手绘风格',
    nodes: [{ id: 'a', label: '开始', kind: 'start' }, { id: 'b', label: '处理' }, { id: 'c', label: '结束', kind: 'end' }],
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
  }, 'sketch 图')
})

await test('真实 Kroki：midnight 深色主题（背景偏蓝黑）', async () => {
  const r = await mustRender({
    type: 'flowchart', theme: 'midnight', title: '深色主题',
    nodes: [{ id: 'a', label: '深色节点' }, { id: 'b', label: '输出' }],
    edges: [{ from: 'a', to: 'b', label: '连线' }],
  }, 'midnight 图')
  if (r) {
    const { createCanvas, loadImage } = await import('@napi-rs/canvas')
    const img = await loadImage(r.path)
    const c = createCanvas(img.width, img.height); const g = c.getContext('2d')
    g.drawImage(img, 0, 0)
    const px = g.getImageData(Math.floor(img.width / 2), 3, 1, 1).data
    ok(px[2] >= px[0] && px[0] < 60 && px[2] > 30, `背景像素偏蓝黑 rgba(${px.join(',')})`)
  }
})

await test('真实 Kroki：DSL 确定性（两次编译同字节）', async () => {
  const { compileD2 } = await import('./compile-d2.js')
  const { THEMES } = await import('./themes.js')
  const spec = { type: 'flowchart', title: 'T', nodes: [{ id: 'a', label: 'A' }], edges: [] }
  const a = compileD2(spec, THEMES.technical); const b = compileD2(spec, THEMES.technical)
  ok(a.dsl === b.dsl, '同一 spec 逐字节稳定')
})

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exit(failed ? 1 : 0)

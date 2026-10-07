/**
 * 外置工具配置约定自检 —— tool.config.js 发现 / schema 归一 / 默认值合并 / 保留键。
 * 运行：node model/toolkit/pack-config.test.mjs
 */
import path from 'node:path'
import Config from '../../utils/Config.js'
import {
  discoverToolPacks, getToolConfig, normalizeSchema, normalizeInfo,
  loadPackConfigDir, registerPackConfig, RESERVED_TOOL_KEYS, SCHEMA_FILE,
} from './pack-config.js'

let passed = 0
let failed = 0
function okf(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const s = JSON.stringify(a) === JSON.stringify(b); okf(s, `${m}${s ? '' : `  (got ${JSON.stringify(a)})`}`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack) } }

await test('normalizeSchema：合法字段 / 非法过滤 / enum 选项归一', () => {
  const fields = normalizeSchema([
    { key: 'enable', type: 'boolean', label: '启用', default: true },
    { key: 'q', type: 'enum', options: ['320', { value: 'flac', label: 'FLAC' }], default: '320' },
    { key: 'n', type: 'number', default: 3, min: 1, max: 9, step: 1, extra: 'x' },
    { key: 'bad key!', type: 'string' }, // 非法 key → 丢弃
    { type: 'string' }, // 缺 key → 丢弃
    { key: 'e', type: 'enum', options: [] }, // 无选项 enum → 丢弃
  ])
  eq(fields.map((f) => f.key), ['enable', 'q', 'n'], '只保留合法字段')
  eq(fields[1].options, [{ value: '320', label: '320' }, { value: 'flac', label: 'FLAC' }], 'enum 选项归一')
  eq(fields[2].min, 1, 'number min 保留')
  okf(!('extra' in fields[2]), '未知字段不透传')
  eq(fields[0].type, 'boolean', 'boolean 保留')
})

await test('normalizeSchema：对象映射形式', () => {
  const fields = normalizeSchema({ a: { type: 'string', default: 'x' }, b: { type: 'number' } })
  eq(fields.map((f) => f.key).sort(), ['a', 'b'], '映射键成为 key')
})

await test('normalizeInfo：缺省与覆盖', () => {
  const d = normalizeInfo(null, 'mypack')
  eq(d.title, 'mypack', '缺 info 时用包名')
  eq(d.version, '1.0.0', '缺省版本')
  const o = normalizeInfo({ title: 'T', description: 'D', author: 'A', version: '2.0' }, 'mypack')
  eq(o, { title: 'T', description: 'D', author: 'A', version: '2.0', homepage: '', icon: '' }, '字段覆盖')
})

await test('loadPackConfigDir：无配置文件返回 null', async () => {
  const r = await loadPackConfigDir(Config.path.plugin, 'plugin-root-no-config')
  eq(r, null, '根目录无 tool.config.js → null')
})

await test('discoverToolPacks：发现 qqmusic 并登记 schema', async () => {
  const packs = await discoverToolPacks(path.join(Config.path.plugin, 'tools'))
  const qq = packs.find((p) => p.name === 'qqmusic')
  okf(!!qq, '发现 qqmusic')
  if (!qq) return
  okf(qq.config.some((f) => f.key === 'enable' && f.type === 'boolean'), '包含 enable 开关')
  okf(qq.config.some((f) => f.key === 'cookie' && f.secret === true), 'cookie 标记 secret')
  okf(qq.config.some((f) => f.key === 'quality' && f.type === 'enum'), 'quality 为 enum')
  eq(qq.info.title, 'QQ 音乐', '标题')
  eq(qq.info.icon, 'music', 'icon 透传（约定字段）')
  okf(!('dir' in qq), '不泄露内部 dir 字段')
})

await test('getToolConfig：schema 默认值 ⊕ 用户值（agent.tools.<包名>）', () => {
  // 注入内存用户值（不落盘，测试进程内）
  const cfg = Config.get()
  if (!cfg.agent) cfg.agent = {}
  if (!cfg.agent.tools || typeof cfg.agent.tools !== 'object') cfg.agent.tools = {}
  cfg.agent.tools.qqmusic = { quality: 'flac', maxResults: 25 }
  try {
    const merged = getToolConfig('qqmusic')
    eq(merged.enable, true, '默认 enable=true')
    eq(merged.quality, 'flac', '用户值覆盖默认 quality')
    eq(merged.maxResults, 25, '用户值覆盖默认 maxResults')
    eq(merged.timeout, 15000, '未覆盖字段取默认')
    eq(merged.cookie, '', 'cookie 默认空串')
  } finally {
    delete cfg.agent.tools.qqmusic
  }
})

await test('保留键：builtin/dir 不作为工具包', () => {
  okf(RESERVED_TOOL_KEYS.has('builtin') && RESERVED_TOOL_KEYS.has('dir'), '保留键集合')
  eq(getToolConfig('builtin'), {}, 'builtin 无 schema → 空')
})

await test('registerPackConfig：手动登记后 getToolConfig 生效', () => {
  registerPackConfig({ name: 'tmp_pack', info: normalizeInfo(null, 'tmp_pack'), config: normalizeSchema([{ key: 'x', type: 'number', default: 7 }]) })
  eq(getToolConfig('tmp_pack').x, 7, '登记后默认值可用')
  eq(SCHEMA_FILE, 'tool.config.js', '约定文件名')
})

console.log(`\n通过 ${passed}，失败 ${failed}`)
if (failed > 0) process.exitCode = 1

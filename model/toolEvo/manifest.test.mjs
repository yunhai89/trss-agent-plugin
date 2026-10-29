/**
 * Tool Manifest 元数据归一化离线自检。
 *
 * 背景（线上报错 2026-10）：
 *   `[toolEvo] seed 失败 manifest 校验失败: /permissions/sideEffects/0 must be equal to one of the allowed values`
 *   内置工具 diagram_render 的 meta 写成 `sideEffects: ['file_write']`，不在 schema 枚举
 *   {none,read,write,network,message,delete} 内 → 整批内置工具 seed 抛错，调用埋点/健康检测全部失效。
 *
 * 覆盖：
 *  ① normalizeSideEffects：别名纠正（file_write→write 等）、去重、空值补 none、未知值收集；
 *  ② makeManifest：脏值进 → 合法值出（schema 校验通过）、未知值不会写入；
 *  ③ validateManifest：六种合法副作用都通过；未归一的脏值仍会被 schema 拒绝（确认 schema 没被放宽）；
 *  ④ generationPermissionViolations：自动生成候选仍只允许 none/read（write/message/delete 一律拒绝）。
 *
 * 运行：node model/toolEvo/manifest.test.mjs
 */
import {
  SIDE_EFFECTS, normalizeSideEffects, makeManifest, validateManifest,
  generationPermissionViolations, isGenerationAllowed,
} from './manifest.js'

let passed = 0, failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const A = JSON.stringify(a), B = JSON.stringify(b); ok(A === B, `${m}${A === B ? '' : `（实际 ${A}，期望 ${B}）`}`) }

console.log('\n[1] normalizeSideEffects：别名 / 去重 / 空值 / 未知')
{
  eq(SIDE_EFFECTS, ['none', 'read', 'write', 'network', 'message', 'delete'], '合法枚举与 schema 一致')
  eq(normalizeSideEffects(['file_write']), { values: ['write'], unknown: [] }, 'file_write → write（本次线上故障项）')
  eq(normalizeSideEffects(['file_write', 'write']), { values: ['write'], unknown: [] }, '别名与合法值去重')
  eq(normalizeSideEffects(['message', 'none']), { values: ['message', 'none'], unknown: [] }, '合法值原样保留（顺序不变）')
  eq(normalizeSideEffects([]), { values: ['none'], unknown: [] }, '空数组 → none')
  eq(normalizeSideEffects(null), { values: ['none'], unknown: [] }, 'null → none')
  eq(normalizeSideEffects('network'), { values: ['network'], unknown: [] }, '字符串输入也能处理')
  eq(normalizeSideEffects(['send', 'http', 'delete_file', 'file_read']), { values: ['message', 'network', 'delete', 'read'], unknown: [] }, '常用别名批量映射')
  eq(normalizeSideEffects(['none', 'bogus', '']), { values: ['none'], unknown: ['bogus'] }, '未知值被剔除并收集（不丢信息）')
  eq(normalizeSideEffects(['bogus']), { values: ['none'], unknown: ['bogus'] }, '全是未知值 → 兜底 none')
}

console.log('\n[2] makeManifest：脏值进 → 合法值出（schema 通过）')
{
  const dirty = makeManifest({
    name: 'diagram_like', version: '1.0.0', status: 'stable', description: '示意图生成（历史脏 meta 重现）',
    inputSchema: { type: 'object' },
    permissions: { sideEffects: ['file_write'], network: { mode: 'deny' } },
  })
  eq(dirty.permissions.sideEffects, ['write'], 'makeManifest 已把 file_write 归一为 write')
  const v = validateManifest(dirty)
  ok(v.ok, `归一后通过 schema 校验${v.ok ? '' : `：${v.errors.join('; ')}`}`)

  const withUnknown = makeManifest({ name: 'x_tool', version: '1.0.0', status: 'draft', description: '未知副作用值', inputSchema: {}, permissions: { sideEffects: ['bogus', 'read'] } })
  eq(withUnknown.permissions.sideEffects, ['read'], '未知值被剔除、合法值保留')
  ok(validateManifest(withUnknown).ok, '剔除未知值后 schema 通过')

  // 默认（不传 sideEffects）→ none
  const def = makeManifest({ name: 'y_tool', version: '1.0.0', status: 'draft', description: '默认副作用', inputSchema: {} })
  eq(def.permissions.sideEffects, ['none'], '未声明 → none')
}

console.log('\n[3] validateManifest：schema 本身没被放宽')
{
  for (const se of SIDE_EFFECTS) {
    const m = makeManifest({ name: 'ok_tool', version: '1.0.0', status: 'draft', description: `副作用 ${se}`, inputSchema: {}, permissions: { sideEffects: [se] } })
    ok(validateManifest(m).ok, `合法值 ${se} 通过校验`)
  }
  const raw = {
    name: 'bad_tool', version: '1.0.0', status: 'draft', description: '未归一脏值应被拒',
    inputSchema: {}, permissions: { sideEffects: ['file_write'], network: { mode: 'deny' } },
  }
  const bad = validateManifest(raw)
  ok(!bad.ok, '未归一化的 file_write 仍被 schema 拒绝（证明是归一化兜底，而非放宽 schema）')
  ok(bad.errors.some((e) => e.includes('sideEffects')), '错误信息指向 sideEffects')
  ok(!validateManifest(makeManifest({ name: 'z_tool', version: '1.0.0', status: 'draft', description: '', inputSchema: {}, permissions: { sideEffects: ['none'] } })).ok, '其它必填校验仍生效（description 太短）')
}

console.log('\n[4] generationPermissionViolations：自动生成候选仍只允许 none/read')
{
  const mk = (se) => makeManifest({ name: 'gen_tool', version: '0.1.0', status: 'draft', description: '生成候选', inputSchema: {}, permissions: { sideEffects: se }, provenance: { kind: 'generated' } })
  ok(isGenerationAllowed(mk(['none'])), 'none 允许自动生成')
  ok(isGenerationAllowed(mk(['read'])), 'read 允许自动生成')
  for (const se of ['write', 'network', 'message', 'delete']) {
    ok(!isGenerationAllowed(mk([se])), `${se} 禁止自动生成（需人工/审批）`)
  }
  // 别名归一后是 write → 同样被生成闸拦住（不会因别名绕过）
  ok(!isGenerationAllowed(mk(['file_write'])), 'file_write（→write）也被生成闸拦住')
  const v = generationPermissionViolations(mk(['file_write']))
  ok(v.some((x) => x.includes('none/read')), '违规原因明确')
}

console.log('\n========================================')
console.log(`通过 ${passed}，失败 ${failed}`)
console.log('========================================')
if (failed > 0) process.exitCode = 1

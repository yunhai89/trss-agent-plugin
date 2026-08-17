/**
 * 离线测试运行器（审计 §8 P1）：递归发现并跑 model/stress 离线测试，汇总通过/失败。
 *
 * 设计：
 *  - 每个测试文件独立子进程跑（互不影响，单文件崩溃不拖垮整体）；
 *  - 解析其「通过 N，失败 M」汇总行（中文）计数，并同时识别 FAIL/THROW 标记；
 *    无汇总行的按 exit code 兜底，避免测试在 exitCode 赋值后继续执行造成假绿灯；
 *  - 不联网、不依赖 API Key；依赖 docker 的测试应自身 graceful skip（见 terminal/test.mjs）。
 *
 * 运行：npm test  或  node scripts/run-tests.mjs
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('..', import.meta.url))
// 注意不含 'web'：按目录名跳过会误伤 model/web/*.test.mjs（logs/humanize-save 两个测试文件
// 曾因此从未被发现——顶层 web/ 是前端静态资源，无 test.mjs/*.test.mjs，无需跳过）
const SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'temp', 'resources', 'out'])
// 这些是人工/网络入口或模块装载钩子，不是可直接执行的离线测试。
const SKIP_STRESS_FILES = new Set(['real-llm.mjs', 'run-real.mjs', 'e2e-fullchain.mjs', 'hooks.mjs'])

function find(dir, out, { stress = false } = {}) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const p = join(dir, name)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) find(p, out, { stress })
    else if (stress
      ? (name.endsWith('.mjs') && !name.startsWith('_') && !SKIP_STRESS_FILES.has(name))
      : (name === 'test.mjs' || name.endsWith('.test.mjs')) && !name.startsWith('_')) out.push(p)
  }
}

const tests = []
find(join(root, 'model'), tests)
const stressTests = []
find(join(root, 'stress'), stressTests, { stress: true })
tests.sort()
const e2eRank = (p) => (p.endsWith('e2e/run.mjs') ? 0 : 1)
stressTests.sort((a, b) => e2eRank(a) - e2eRank(b) || a.localeCompare(b))
tests.push(...stressTests)

let passFiles = 0
let failFiles = 0
const reSummary = /通过\s*(\d+)\s*[，,]\s*失败\s*(\d+)/

for (const t of tests) {
  const rel = t.replace(root, '')
  const args = rel === 'stress/e2e/run.mjs'
    ? ['--import', join(root, 'stress/e2e/hooks.mjs'), t]
    : [t]
  const r = spawnSync(process.execPath, args, {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000,
  })
  const out = (r.stdout || '') + (r.stderr || '')
  const m = out.match(reSummary)
  const markerFailures = (out.match(/✗ (?:FAIL|THROW)|FAIL:|THROW:/g) || []).length
  const failedCount = Math.max(
    m ? Number(m[2]) : 0,
    markerFailures,
    r.status === 0 ? 0 : 1,
  )
  if (r.status === 0 && failedCount === 0) {
    passFiles++
    const total = m ? Number(m[1]) + Number(m[2]) : '?'
    console.log(`  ✓ ${rel}  (${m ? `${m[1]} 断言` : 'ok'})`)
  } else {
    failFiles++
    console.log(`  ✗ ${rel}  (exit ${r.status}${r.signal ? `, ${r.signal}` : ''}, 失败 ${failedCount})`)
    console.log(out.split('\n').filter((l) => /✗|FAIL|THROW|Error|通过.*失败/.test(l)).slice(-8).map((l) => '      ' + l).join('\n'))
  }
}

console.log(`\n========================================`)
console.log(`测试文件 通过 ${passFiles}，失败 ${failFiles}（共 ${tests.length}）`)
console.log(`========================================`)
process.exit(failFiles > 0 ? 1 : 0)

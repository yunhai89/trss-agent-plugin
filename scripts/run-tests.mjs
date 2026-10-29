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
// 前端自检里依赖浏览器/DOM 的文件不在此跑（由人工或 CI 浏览器环境执行）
const SKIP_WEBDEV_FILES = new Set(['render-check.mjs'])
const SKIP_STRESS_FILES = new Set(['real-llm.mjs', 'run-real.mjs', 'e2e-fullchain.mjs', 'hooks.mjs'])

function find(dir, out, { stress = false, webdev = false } = {}) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const p = join(dir, name)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) find(p, out, { stress, webdev })
    else if (stress
      ? (name.endsWith('.mjs') && !name.startsWith('_') && !SKIP_STRESS_FILES.has(name))
      : webdev
        ? (name.endsWith('.mjs') && !name.startsWith('_') && !SKIP_WEBDEV_FILES.has(name))
        : (name === 'test.mjs' || name.endsWith('.test.mjs')) && !name.startsWith('_')) out.push(p)
  }
}

const tests = []
find(join(root, 'model'), tests)
find(join(root, 'apps'), tests) // 入口层离线自检（apps/*.test.mjs，如更新日志转发）
find(join(root, 'tools'), tests) // 外置工具离线自检（tools/<包>/*.test.mjs）
find(join(root, 'web', 'dev'), tests, { webdev: true }) // 前端纯逻辑自检（web/dev/*.mjs，无需浏览器）
const stressTests = []
find(join(root, 'stress'), stressTests, { stress: true })
tests.sort()
const e2eRank = (p) => (p.endsWith('e2e/run.mjs') ? 0 : 1)
stressTests.sort((a, b) => e2eRank(a) - e2eRank(b) || a.localeCompare(b))
tests.push(...stressTests)

// 被 SKIP_STRESS_FILES 排除的文件（需真实凭据/为驱动器）：如实列出并计入总数，避免"静默消失"
const excludedStress = []
for (const dir of ['stress/anti-misread', 'stress/e2e', 'stress/real', 'stress']) {
  let names = []
  try { names = readdirSync(join(root, dir)) } catch { continue }
  for (const name of names) {
    if (!name.endsWith('.mjs') || name.startsWith('_')) continue
    if (!SKIP_STRESS_FILES.has(name)) continue
    const rel = join(dir, name)
    if (!excludedStress.includes(rel)) excludedStress.push(rel)
  }
}

let passFiles = 0
let failFiles = 0
let skipFiles = 0
const reSummary = /通过\s*(\d+)\s*[，,]\s*失败\s*(\d+)/

// 需要先装 Yunzai 桩钩子才能跑的真实入口测试（其余 stress 文件是纯离线断言）
const HOOKED_STRESS = new Set([
  'stress/e2e/run.mjs', 'stress/e2e/agent-init-failure.mjs', 'stress/e2e/agent-sandbox-wiring.mjs',
  'stress/e2e/tool-category-audit.mjs', // 全量工具必须声明合法 RBAC category（memory 漏声明实机事故回归）
  'stress/e2e/compaction-clear.mjs', // F02：清空记录必须连同压缩归档一起清理 + 会话 id 不复用
  // 真实 Web router 测试需要 Yunzai 桩（apps/agent.js / lib 解析）
  'model/web/api.tevo.test.mjs',
  'model/web/api.persona-lore.test.mjs',
  'model/web/api.clearcache.test.mjs', // 清空 Token 缓存统计：真实 router + 真实 UsageStats + 桩 runtime
  'model/web/api.qqbot.test.mjs', // QQBot 账号 API：真实 router + 桩适配器/Config
  'model/web/api.web-console.test.mjs', // 启动默认地址 API：真实 router + 真实 auth 中间件
  // 更新日志转发测试需要 Yunzai 桩（apps/update.js / lib 插件基类 + Bot）
  'apps/update.test.mjs',
  // TTS 路由测试需要桩 Config（写配置不落盘真实 config.yaml）
  'model/web/tts.test.mjs',
  // 指令画图插件测试需要桩插件基类 + 桩 Config
  'apps/comfyui-draw.test.mjs',
])
for (const t of tests) {
  const rel = t.replace(root, '')
  const args = HOOKED_STRESS.has(rel)
    ? ['--import', join(root, 'stress/e2e/hooks.mjs'), t]
    : [t]
  const r = spawnSync(process.execPath, args, {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000,
  })
  const out = (r.stdout || '') + (r.stderr || '')
  const m = out.match(reSummary)
  // 整文件 skip（如真实浏览器集成测试缺少 STAGEHAND_BROWSER_PATH）：显式标记，不计入通过
  const wholeSkip = /(^|\n)SKIP_FILE:/.test(out)
  if (wholeSkip && r.status === 0) {
    skipFiles++
    console.log(`  ⊘ ${rel}  (skip)`)
    continue
  }
  // 识别常见失败标记：行首 ✗（含普通 ✗ / ✗ FAIL / ✗ THROW）与 FAIL:/THROW:
  const markerFailures = (out.match(/^\s*✗|FAIL:|THROW:/gm) || []).length
  const failedCount = Math.max(
    m ? Number(m[2]) : 0,
    markerFailures,
    r.status === 0 ? 0 : 1,
  )
  if (r.status === 0 && failedCount === 0) {
    passFiles++
    console.log(`  ✓ ${rel}  (${m ? `${m[1]} 断言` : 'ok'})`)
  } else {
    failFiles++
    console.log(`  ✗ ${rel}  (exit ${r.status}${r.signal ? `, ${r.signal}` : ''}, 失败 ${failedCount})`)
    console.log(out.split('\n').filter((l) => /✗|FAIL|THROW|Error|通过.*失败/.test(l)).slice(-8).map((l) => '      ' + l).join('\n'))
  }
}

for (const rel of excludedStress) {
  skipFiles++
  console.log(`  ⊘ ${rel}  (skip: 需真实凭据或为驱动器，人工/CI 显式运行)`)
}

console.log(`\n========================================`)
console.log(`测试文件 通过 ${passFiles}，失败 ${failFiles}，跳过 ${skipFiles}（共 ${tests.length + excludedStress.length}）`)
console.log(`========================================`)
process.exit(failFiles > 0 ? 1 : 0)

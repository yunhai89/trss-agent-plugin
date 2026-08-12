/**
 * 回归测试：伪人模式白名单保存契约（T1）。
 *
 * 用真实 Vue（web/vendor/vue.global.prod.js，vm 沙箱）复刻 humanize.js 的
 * syncForm + watch(form,deep) + buildChanges 数据流，断言：
 *   - TagEditor 整体替换数组（add/del）后 dirty 必为 true；
 *   - buildChanges(origSnapshot, form) 必产生 agent.humanize.groups 点路径变更。
 *
 * 锁定「数组字段变更 → dirty + 点路径 changes」的不变量，防止 syncForm/watch/buildChanges
 * 回归（如 form 与 store 共享引用、watcher 时序、除零类问题）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const __dirname = dirname(fileURLToPath(import.meta.url))
const vuePath = join(__dirname, '..', '..', 'web', 'vendor', 'vue.global.prod.js')
const vueSrc = readFileSync(vuePath, 'utf8')

const sandbox = {
  console,
  setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  Promise, queueMicrotask: (fn) => Promise.resolve().then(fn),
  Symbol, Reflect, Proxy, Map, Set, WeakMap, WeakSet, Array, Object, JSON, Error, Number, String, Boolean, Math, Date,
}
sandbox.window = sandbox
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(vueSrc, sandbox, { filename: 'vue.global.prod.js' })
const { reactive, ref, watch, nextTick } = sandbox.Vue

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✔ ' + m) } else { fail++; console.error('  ✘ ' + m) } }

const DEFAULTS = { enable: false, groups: [], planner: { model: '', allowedReadTools: [] } }
function withDefaults(h) {
  const merge = (base, over) => {
    const out = Array.isArray(base) ? [...base] : { ...base }
    for (const k of Object.keys(base)) {
      if (over && typeof over[k] !== 'undefined' && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) out[k] = merge(base[k], over[k])
      else if (over && typeof over[k] !== 'undefined') out[k] = over[k]
    }
    return out
  }
  return merge(DEFAULTS, h || {})
}
const buildChanges = (orig, frm, prefix = 'agent.humanize', out = {}) => {
  for (const k of Object.keys(frm)) {
    const p = prefix + '.' + k, a = orig?.[k], b = frm[k]
    if (b && typeof b === 'object' && !Array.isArray(b) && a && typeof a === 'object') buildChanges(a, b, p, out)
    else if (JSON.stringify(a) !== JSON.stringify(b)) out[p] = b
  }
  return out
}

function makeForm() {
  const form = reactive({})
  let dirtySuppressed = true
  const dirty = ref(false)
  watch(form, () => { if (!dirtySuppressed) dirty.value = true }, { deep: true })
  let origSnapshot = {}
  const syncForm = (snap) => {
    dirtySuppressed = true
    const detached = withDefaults(JSON.parse(JSON.stringify(snap || {})))
    for (const k of Object.keys(form)) delete form[k]
    Object.assign(form, detached)
    origSnapshot = JSON.parse(JSON.stringify(form))
    dirty.value = false
    nextTick(() => { dirtySuppressed = false })
  }
  return { form, dirty, syncForm, getOrig: () => origSnapshot }
}

await (async () => {
  // 场景 1：store 含 reactive groups（foreign 引用），add 一个群号
  {
    const { form, dirty, syncForm, getOrig } = makeForm()
    const store = reactive({ groups: [] })
    syncForm(store)
    await nextTick()
    ok(dirty.value === false, '初始 dirty=false')

    // TagEditor add：整体替换数组
    form.groups = [...form.groups, '123456']
    await nextTick()
    ok(dirty.value === true, 'add 群号后 dirty=true')
    const changes = buildChanges(getOrig(), JSON.parse(JSON.stringify(form)))
    ok(!!changes['agent.humanize.groups'] && JSON.stringify(changes['agent.humanize.groups']) === '["123456"]',
      'add 产生 agent.humanize.groups=["123456"]')
  }

  // 场景 2：已有多个群号，删除一个
  {
    const { form, dirty, syncForm, getOrig } = makeForm()
    const store = reactive({ groups: ['111', '222'] })
    syncForm(store)
    await nextTick()
    form.groups = form.groups.filter((_, j) => j !== 0) // del(0)
    await nextTick()
    ok(dirty.value === true, 'del 群号后 dirty=true')
    const changes = buildChanges(getOrig(), JSON.parse(JSON.stringify(form)))
    ok(JSON.stringify(changes['agent.humanize.groups']) === '["222"]', 'del 产生 agent.humanize.groups=["222"]')
  }

  // 场景 3：未改动时 changes 必须为空（防止误报/漏报）
  {
    const { form, dirty, syncForm, getOrig } = makeForm()
    syncForm(reactive({ groups: ['111'], planner: { model: 'm' } }))
    await nextTick()
    ok(dirty.value === false, 'syncForm 后未交互 dirty=false')
    ok(Object.keys(buildChanges(getOrig(), JSON.parse(JSON.stringify(form)))).length === 0, '未改动 changes 为空')
  }

  // 场景 4：嵌套对象字段改动（planner.model）也能触发 dirty + 点路径变更
  {
    const { form, dirty, syncForm, getOrig } = makeForm()
    syncForm(reactive({ planner: { model: 'a' } }))
    await nextTick()
    form.planner.model = 'b'
    await nextTick()
    ok(dirty.value === true, '嵌套字段改 dirty=true')
    ok(buildChanges(getOrig(), JSON.parse(JSON.stringify(form)))['agent.humanize.planner.model'] === 'b', '嵌套点路径变更')
  }
})()

console.log(`\n通过 ${pass}，失败 ${fail}`)
process.exit(fail ? 1 : 0)

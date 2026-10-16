/**
 * RecallStore 群共享作用域迁移 / 清空语义回归用例。
 *
 * 背景（第 8 轮审计 medium-2 / 回归审计 medium-6）：
 *  - medium-6：群共享模式（isolation=false）的键从字面量 `__group__` 换成 `__group__:<gid>` 后，
 *    新作用域读不到旧记录会造成「升级后机器人失忆」，需要一次性回退读旧池；
 *  - medium-2：但**只有「键不存在」才该回退**。若把「显式空数组」也当成缺失，用户删光/清空记忆后
 *    旧池会被重新注入（删掉的记忆复活），且 clearAll 不删旧池时用户没有任何手段清干净。
 */
import { RecallStore } from './recall.js'

let pass = 0, fail = 0
const ok = (c, m) => { c ? pass++ : (fail++, console.log(`  ✗ ${m}`)) }

function mkKv(init = {}) {
  const map = new Map(Object.entries(init))
  return {
    map,
    async get(k) { return map.has(k) ? map.get(k) : null },
    async set(k, v) { map.set(k, JSON.parse(JSON.stringify(v))) },
    async del(k) { map.delete(k) },
  }
}

const entry = (content, id = content) => ({ id, content, type: 'fact', level: 'L3', ts: Date.now(), useCount: 0, citedCount: 0 })

// 1) 旧键（字面量 __group__）有新键缺失 → 回退并入（升级不失忆）
{
  const kv = mkKv({ 'Yz:agent:mem:__group__': [entry('旧池记忆A'), entry('旧池记忆B')] })
  const store = new RecallStore({ kv })
  const all = await store._all('__group__:g1')
  ok(Array.isArray(all) && all.length === 2 && all[0].content === '旧池记忆A', '新作用域缺失时并入旧跨群池')
  ok(await store._all('__group__:g2') !== null, '另一个群同样可回退（该模式本就是跨群共享池）')
}

// 2) 新键存在但为空数组（已被清空）→ 绝不回退，否则删掉的记忆复活
{
  const kv = mkKv({ 'Yz:agent:mem:__group__:g1': [], 'Yz:agent:mem:__group__': [entry('旧池记忆A')] })
  const store = new RecallStore({ kv })
  const all = await store._all('__group__:g1')
  ok(Array.isArray(all) && all.length === 0, '显式空数组不回退（审计 medium-2：删除后不得复活）')
}

// 3) 普通用户作用域不做任何回退
{
  const kv = mkKv({ 'Yz:agent:mem:__group__': [entry('旧池记忆A')] })
  const store = new RecallStore({ kv })
  const all = await store._all('u123')
  ok(Array.isArray(all) && all.length === 0, '个人作用域不回退旧群池')
}

// 4) clearAll（群共享）同时删旧池 → 之后再读仍为空（用户能真正清干净）
{
  const kv = mkKv({ 'Yz:agent:mem:__group__:g1': [entry('新池')], 'Yz:agent:mem:__group__': [entry('旧池记忆A')] })
  const store = new RecallStore({ kv })
  await store.clearAll('__group__:g1')
  ok(!kv.map.has('Yz:agent:mem:__group__:g1'), 'clearAll 删新键')
  ok(!kv.map.has('Yz:agent:mem:__group__'), 'clearAll 一并删遗留跨群池')
  const all = await store._all('__group__:g1')
  ok(all.length === 0, '清空后不再回退到旧池')
}

// 5) 个人 clearAll 不误删群池
{
  const kv = mkKv({ 'Yz:agent:mem:u1': [entry('x')], 'Yz:agent:mem:__group__': [entry('旧池记忆A')] })
  const store = new RecallStore({ kv })
  await store.clearAll('u1')
  ok(kv.map.has('Yz:agent:mem:__group__'), '个人清空不动群共享池')
}

console.log(`\nrecall 作用域测试：通过 ${pass}，失败 ${fail}`)
process.exit(fail ? 1 : 0)

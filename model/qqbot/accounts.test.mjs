/**
 * QQBot 账号读写（Web「账号」页数据层）离线自检。
 *
 * 覆盖：
 *  ① 扁平单账号（appId/appSecret）与多账号 accounts[] 两种写法都能列出；
 *  ② 写前归一：扁平写法自动迁进 accounts[] 并清掉扁平字段（幂等）；
 *  ③ 新增/更新/删除：appSecret 留空=保持原值、appId 校验、字段归一（markdown/intents/bool）；
 *  ④ 对外视图永不含 appSecret 明文（只有 hasSecret + 掩码）；
 *  ⑤ 适配器条目形状（toAdapterAccount）。
 *
 * 运行：node model/qqbot/accounts.test.mjs
 */
import {
  listAccounts, normalizeAccountsConfig, upsertAccount, removeAccount, publicAccount, toAdapterAccount,
} from './accounts.js'

let passed = 0
let failed = 0
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}${JSON.stringify(a) === JSON.stringify(b) ? '' : `（实际 ${JSON.stringify(a)}）`}`)

console.log('\n[1] 读取：accounts[] 与扁平单账号')
{
  const a1 = listAccounts({ qqBot: { accounts: [{ appId: '1001', appSecret: 's1', name: '一号' }, { appId: '1002', appSecret: 's2' }] } })
  eq(a1.map((a) => a.appId), ['1001', '1002'], 'accounts[] 全部列出')
  eq(a1[0].name, '一号', '保留名称')
  eq(a1[1].name, '1002', '名称留空用 appId')
  ok(a1.every((a) => a.source === 'accounts'), 'source=accounts')

  const a2 = listAccounts({ qqBot: { appId: '2001', appSecret: 'sx', sandbox: true, intents: 1073741825 } })
  eq(a2.length, 1, '扁平写法视为单账号')
  eq([a2[0].appId, a2[0].sandbox, a2[0].intents, a2[0].source], ['2001', true, 1073741825, 'flat'], '扁平字段带出')

  eq(listAccounts({}), [], '空配置返回空列表')
  eq(listAccounts({ qqBot: { accounts: [{ appId: '1001' }, { appId: '1001' }, { appId: '' }] } }).length, 1, '重复 appId 去重、空 appId 跳过')
  // 已有 accounts 时扁平字段被忽略（单一真源）
  eq(listAccounts({ qqBot: { appId: '9999', appSecret: 'x', accounts: [{ appId: '1001', appSecret: 's' }] } }).map((a) => a.appId), ['1001'], 'accounts 存在时扁平字段不参与')
}

console.log('\n[2] 写前归一（扁平 → accounts[]）')
{
  const agent = { qqBot: { enable: true, appId: '3001', appSecret: 'sec', sandbox: true, markdown: 'false' } }
  eq(normalizeAccountsConfig(agent), true, '检测到需要迁移')
  eq(agent.qqBot.accounts.length, 1, '已迁入 accounts[]')
  eq(agent.qqBot.accounts[0].appSecret, 'sec', '密钥随迁移保留')
  ok(!('appId' in agent.qqBot) && !('appSecret' in agent.qqBot), '扁平字段已清除')
  eq(normalizeAccountsConfig(agent), false, '再次归一幂等（返回 false）')
  eq(normalizeAccountsConfig({ qqBot: { accounts: [] } }), false, '无扁平字段时不需要迁移')
}

console.log('\n[3] 新增 / 更新 / 删除')
{
  const agent = { qqBot: {} }
  const r1 = upsertAccount(agent, { appId: '4001', appSecret: 'secret1', name: '主号' })
  ok(r1.ok && r1.created, '新增成功')
  eq(agent.qqBot.enable, true, '加账号自动 enable=true')
  eq(agent.qqBot.accounts[0].name, '主号', '名称写入')

  const r2 = upsertAccount(agent, { appId: '4001', name: '改名' })
  ok(r2.ok && !r2.created, '同 appId 视为更新')
  eq(agent.qqBot.accounts.length, 1, '不会重复新增')
  eq(agent.qqBot.accounts[0].appSecret, 'secret1', 'appSecret 留空=保持原值')
  eq(agent.qqBot.accounts[0].name, '改名', '其余字段可改')

  eq(upsertAccount(agent, { appId: 'abc' }).ok, false, '非数字 appId 被拒')
  eq(upsertAccount(agent, { appSecret: 'x' }).ok, false, '缺 appId 被拒')
  eq(upsertAccount(agent, { appId: '5555' }).ok, false, '新增缺 appSecret 被拒')
  eq(upsertAccount(agent, { appId: '4001', appSecret: 'secret2' }).ok, true, '显式传密钥可更新')
  eq(agent.qqBot.accounts[0].appSecret, 'secret2', '密钥已更新')

  // 字段归一
  upsertAccount(agent, { appId: '4001', markdown: true, intents: '-1', sandbox: 'true', preferMarkdownText: 1 })
  eq([agent.qqBot.accounts[0].markdown, agent.qqBot.accounts[0].intents, agent.qqBot.accounts[0].sandbox, agent.qqBot.accounts[0].preferMarkdownText],
    ['true', 0, true, true], 'markdown 布尔→字符串、intents 负数回 0、字符串布尔归一')

  const r3 = removeAccount(agent, '4001')
  ok(r3.ok && r3.removed, '删除成功')
  eq(listAccounts(agent).length, 0, '列表为空')
  eq(removeAccount(agent, '4001').removed, false, '删不存在的账号 removed=false')

  // 扁平配置下的删除：先迁移再删
  const agent2 = { qqBot: { appId: '6001', appSecret: 's' } }
  ok(removeAccount(agent2, '6001').removed, '扁平账号也能删除')
  ok(!('appId' in agent2.qqBot), '删除后扁平字段已清理')
}

console.log('\n[4] 对外视图不含明文密钥')
{
  const acc = { appId: '7001', appSecret: 'abcdefghijkl', name: 'n', source: 'accounts' }
  const pub = publicAccount(acc, { state: 'ready', connected: true })
  ok(!('appSecret' in pub), 'publicAccount 不含 appSecret 字段')
  eq(pub.hasSecret, true, 'hasSecret=true')
  eq(pub.secretMasked, '••••••••ijkl', '只给尾部 4 位掩码')
  eq(pub.status.state, 'ready', '合并连接状态')
  const pub2 = publicAccount({ appId: '7002' })
  eq([pub2.hasSecret, pub2.secretMasked], [false, ''], '无密钥时标记未配置')
  const pub3 = publicAccount({ appId: '7003', appSecret: 'short' })
  eq(pub3.secretMasked, '••••••••', '短密钥不给尾部')
}

console.log('\n[5] 适配器条目形状')
{
  const a = toAdapterAccount({ appId: '8001', appSecret: 's', name: 'n', sandbox: true, intents: 513, markdown: 'false', preferMarkdownText: true, apiBase: 'https://x', tokenUrl: 'https://y' })
  eq(a, { appId: '8001', appSecret: 's', name: 'n', sandbox: true, intents: 513, markdown: 'false', preferMarkdownText: true, apiBase: 'https://x', tokenUrl: 'https://y' }, '字段与 apps/qqbot.js normalizeAccounts 对齐')
  eq(toAdapterAccount({ appId: '8002' }).name, '8002', '名称缺省用 appId')
}

console.log('\n========================================')
console.log(`通过 ${passed}，失败 ${failed}`)
console.log('========================================')
if (failed > 0) process.exitCode = 1

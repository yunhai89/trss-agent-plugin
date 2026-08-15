// E2E loader hooks —— 把 Yunzai/环境依赖替换为桩，其余全部跑真实源码。
// 用法：node --import ./stress/e2e/hooks.mjs stress/e2e-fullchain.mjs
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const SRC = path.resolve(import.meta.dirname, '../..')
const STUB = path.join(SRC, 'stress/e2e/stubs')

registerHooks({
  resolve(specifier, context, nextResolve) {
    // Yunzai 基类：源码仓内相对路径解析不到（../../../lib 只在生产目录存在）→ 直接按后缀拦截
    if (/^(\.\.\/)+lib\/plugins\/plugin\.js$/.test(specifier) || /\/lib\/plugins\/plugin\.js$/.test(specifier)) {
      return { url: pathToFileURL(path.join(STUB, 'plugin.js')).href, shortCircuit: true }
    }
    const r = nextResolve(specifier, context)
    const url = r?.url || ''
    // 本仓库 apps/agent.js → 桩（getRuntime）
    if (url === pathToFileURL(path.join(SRC, 'apps/agent.js')).href) {
      return { url: pathToFileURL(path.join(STUB, 'agent.js')).href, shortCircuit: true }
    }
    // 本仓库 utils/Config.js → 桩（内存配置 + 临时目录）
    if (url === pathToFileURL(path.join(SRC, 'utils/Config.js')).href) {
      return { url: pathToFileURL(path.join(STUB, 'Config.js')).href, shortCircuit: true }
    }
    return r
  },
})

// 全局 Bot 桩：pickGroup().sendMsg() 捕获出站消息（makeSendFn 走这里）
const sent = []
globalThis.__E2E_SENT = sent
globalThis.Bot = {
  uin: '2721779039',
  uins: ['2721779039'],
  nickname: '小汐',
  pickGroup(gid) {
    return {
      async sendMsg(msg) {
        const id = 'bot_' + (sent.length + 1)
        sent.push({ gid: String(gid), msg, id, at: Date.now() })
        return { message_id: id }
      },
    }
  },
}

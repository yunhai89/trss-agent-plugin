/**
 * Web 管理面板入口（Yunzai plugin）。
 *  - 构造时幂等启动 HTTP server（webApi.enable !== false）
 *  - #agents登录（permission:master）：私聊发带 token 的登录地址（24h 有效）
 *  - webApi.enable/port 变化时重启 server（常规配置热加载不重启）
 */
import plugin from '../../../lib/plugins/plugin.js'
import Config from '../utils/Config.js'
import Log from '../utils/Log.js'
import { startServer, stopServer } from '../model/web/server.js'
import { handleAgentsLogin } from '../model/web/auth.js'

let _started = false
let _watchedPort = null

// webApi.enable/port 变化 → 重启 server（Config 热加载触发；与 agent.js 的 invalidateRuntime 并列订阅）
Config.onChange(async () => {
  const cfg = Config.get().agent?.webApi || {}
  const port = Number(cfg.port) || 6098
  if (cfg.enable === false) {
    if (_started) { await stopServer(); _started = false; _watchedPort = null }
    return
  }
  if (_started && _watchedPort !== port) {
    await stopServer()
    _started = false
    _watchedPort = null
    startServer().then(() => { _started = true; _watchedPort = port }).catch(() => {})
    return
  }
  // enable 由 false→true（或启动时即开启）时补启动：此前只处理「已启动且端口变化」，
  // 一旦关闭过就再也开不回来，必须重启进程才生效。
  if (!_started) {
    startServer().then(() => { _started = true; _watchedPort = port }).catch(() => {})
  }
})

export class WebAdmin extends plugin {
  constructor() {
    super({
      name: 'agents管理面板',
      dsc: 'Web 管理面板 HTTP 服务 + #agents登录',
      event: 'message',
      priority: 0,
      rule: [{ reg: '^#agents登录$', fnc: 'login', permission: 'master' }],
    })
    const cfg = Config.get().agent?.webApi || {}
    if (cfg.enable !== false && !_started) {
      _started = true
      _watchedPort = Number(cfg.port) || 6098
      startServer().catch((e) => { _started = false; Log.error('[web] 面板启动失败', e?.message || e) })
    }
  }

  async login() {
    return handleAgentsLogin(this.e)
  }
}

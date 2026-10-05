/**
 * Web 管理面板 HTTP 服务（独立于锅巴）。
 * Yunzai 自带 express（5.2.1）；静态托管 web/ + /api 路由（鉴权）+ SPA 兜底。
 * 监听 0.0.0.0:port（默认 6098）——该绑定**同时覆盖本地回环(127.0.0.1)与公网**，本地访问固定生效、无需任何配置；
 * 幂等启动；仅 webApi.{enable,port} 变化才重启（不随常规配置热加载重启）。
 */
import express from 'express'
import path from 'node:path'
import Config from '../../utils/Config.js'
import Log from '../../utils/Log.js'
import { authMiddleware } from './auth.js'
import { errorMiddleware } from './response.js'
import { buildApiRouter } from './api.js'

let _server = null
let _curPort = null

export async function startServer() {
  if (_server) return _server
  const cfg = Config.get().agent?.webApi || {}
  if (cfg.enable === false) return null
  const port = Number(cfg.port) || 6098
  const webDir = path.join(Config.path.plugin, 'web')

  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '1mb' }))
  app.use('/api', authMiddleware, buildApiRouter())
  app.use(express.static(webDir))
  // SPA 兜底（支持 ?token= 直进首页）；/api 未匹配已在 router 内返 JSON 404
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) return next()
    res.sendFile(path.join(webDir, 'index.html'), (err) => { if (err) next(err) })
  })
  app.use(errorMiddleware)

  // 0.0.0.0 已同时监听公网与本地回环，本地地址固定可用（#agents登录 会分别给出公网/本地两条地址）
  _server = app.listen(port, '0.0.0.0', () => Log.mark(`[web] 管理面板已启动：0.0.0.0:${port}（公网+本地 127.0.0.1；私聊 #agents登录 取访问地址）`))
  _curPort = port
  _server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') Log.warn(`[web] 端口 ${port} 被占用，面板未启动；改 agent.webApi.port 后 #agents重载`)
    else Log.error('[web] 面板服务错误', e?.message || e)
  })
  return _server
}

export function stopServer() {
  return new Promise((resolve) => {
    if (!_server) return resolve()
    const s = _server
    _server = null
    _curPort = null
    s.close(() => { Log.mark('[web] 管理面板已停止'); resolve() })
  })
}

export function isRunning() { return !!_server }
export function currentPort() { return _curPort }

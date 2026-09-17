/**
 * Stagehand 浏览器启动 —— 本地(Playwright+chromium)或 Browserbase 云。
 *
 * 动态 import @browserbasehq/stagehand；未装则抛错（由调用方捕获降级，与 comfyui/pixiv 同模式）。
 * 只负责拿到 browser 对象 + 一个 close 句柄；Stagehand.create 由 session.js 调。
 */
import Log from '../../utils/Log.js'
import { buildLaunchOptions } from './guard.js'

let _mod = null
async function getMod() {
  if (!_mod) {
    const m = await import('@browserbasehq/stagehand')
    _mod = m.default || m
  }
  return _mod
}

/**
 * 启动浏览器。
 * @param {object} cfg agent.stagehand 配置（mode/headless/executablePath/browserbaseApiKey/region）
 * @returns {Promise<{browser, close: ()=>Promise<void>}>}
 */
export async function launchBrowser(cfg = {}, profile = null) {
  const { localBrowser, browserbase } = await getMod()
  const mode = cfg.mode || 'local'
  if (mode === 'cloud') {
    const apiKey = cfg.browserbaseApiKey
    if (!apiKey) throw new Error('stagehand 云模式需配 agent.stagehand.browserbaseApiKey')
    const opts = { apiKey }
    if (cfg.region) opts.region = cfg.region
    Log.info('[stagehand] 启动 Browserbase 云浏览器', cfg.region || 'us-west-2')
    const browser = await browserbase.launch(opts)
    return { browser, close: () => browser.close().catch(() => {}) }
  }
  // local（stealth 默认开：真机 UA/视口/语言 + 去自动化 flag）
  const opts = buildLaunchOptions(cfg, profile || undefined)
  Log.info('[stagehand] 启动本地浏览器', opts.headless ? 'headless' : 'headed', opts.executablePath || '(默认chromium)', cfg.stealth === false ? 'stealth=off' : `fingerprint=${profile?.name || 'default'}`)
  const browser = await localBrowser.launch(opts)
  return { browser, close: () => browser.close().catch(() => {}) }
}

/** 取 Stagehand 主类（session.js 用）。 */
export async function getStagehandClass() {
  const { Stagehand } = await getMod()
  return Stagehand
}

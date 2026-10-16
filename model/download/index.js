/**
 * web_download —— 基于 yt-dlp 的视频/媒体下载工具（受约束，master 限定）。
 *
 * 为什么需要它：下载视频/媒体时，LLM 若没有专用工具会去抓 terminal 裸 shell（不安全、且 curl/wget
 * 下不动需要解析的真实视频站）。本工具封装 yt-dlp（支持 1000+ 站点），给 LLM 一个趁手且受约束的入口。
 * 与 terminal 的区别：不接受任意命令，只接受 URL + 格式；输出到固定临时目录；大小/超时硬上限；
 * 下完自动发聊天并清理。category:'system' → 仅框架主人可用。
 *
 * 执行面（2025-10 变更）：显式选择 E2B（agent.sandbox.mode=e2b）后，yt-dlp **在会话沙箱内执行**，
 * 文件流式拉回宿主临时目录再发送；沙箱不可用或模板缺 yt-dlp 时结构化失败，绝不回落宿主执行。
 * mode=off（未配置沙箱）时保持旧的宿主执行路径。
 *
 * 安全约束（代码层）：
 *   ① 仅 http(s) URL（拒绝 file:// / 本地路径 / 非 http 协议）；
 *   ② 输出到 per-call 临时子目录（无路径穿越）；
 *   ③ --no-playlist（不抓整个播放列表）+ --max-filesize（超限中止）+ 超时 SIGKILL；
 *   ④ argv 数组（宿主 spawn 不经 shell）/ sandbox 命令逐参数 shellQuote（URL/format 无注入面）；
 *   ⑤ 大文件不发（超 sendLimitBytes 只返回本地路径，供 SFTP 取，不塞 QQ）。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import Config from '../../utils/Config.js'
import { toFileSegment } from '../../utils/SendFile.js'
import Log from '../../utils/Log.js'
import { toolSandbox, sandboxSelected, sandboxUnavailableError, openToolSession, runToolCommand, missingCommand, sandboxTmp, shellQuote } from '../sandbox/bridge.js'

const MB = 1024 * 1024

function trunc(s, max) {
  const t = String(s == null ? '' : s)
  return t.length <= max ? t : t.slice(0, max) + `\n…[已截断，共 ${t.length} 字符]`
}

/**
 * yt-dlp 参数（宿主 argv / 沙箱命令共用同一份拼装——避免两处口径漂移）。
 * @returns {string[]}
 */
export function buildYtDlpArgs(url, { outTmpl, format = 'best[ext=mp4]/best', audioOnly = false, maxBytes = 600 * MB, mergeFormat = 'mp4', extraArgs = [] } = {}) {
  const args = [
    '--no-playlist', '--no-cache-dir', '--no-warnings', '--newline',
    '--retries', '3', '--socket-timeout', '30',
    '--max-filesize', String(Math.floor(maxBytes)),
    '-o', outTmpl,
  ]
  if (audioOnly) {
    args.push('-x', '--audio-format', 'mp3', '--audio-quality', '5')
  } else {
    args.push('-f', format)
    if (mergeFormat) args.push('--merge-output-format', mergeFormat)
  }
  args.push(...extraArgs, url)
  return args
}

/**
 * 用 yt-dlp 下载（宿主档）。返回 { ok, files:[abs], stderr, durationMs, timedOut? }。
 * files 为输出目录里本次产出的文件（按 mtime 排序）。
 */
export async function runYtDlp(url, opts = {}) {
  const {
    dir,
    format = 'best[ext=mp4]/best',
    audioOnly = false,
    maxBytes = 600 * MB,       // --max-filesize 上限（yt-dlp 超过则中止该文件）
    timeoutSec = 600,
    extraArgs = [],
    ytDlpBin = 'yt-dlp',
    mergeFormat = 'mp4',
  } = opts

  fs.mkdirSync(dir, { recursive: true })
  const outTmpl = path.join(dir, '%(title).80B.%(ext)s')
  const args = buildYtDlpArgs(url, { outTmpl, format, audioOnly, maxBytes, mergeFormat, extraArgs })

  const t0 = Date.now()
  const ms = Math.min(Math.max(30, Number(timeoutSec) || 600), 1800) * 1000
  return new Promise((resolve) => {
    let stderr = ''
    let proc
    const done = (r) => {
      try {
        const files = fs.readdirSync(dir).map((n) => path.join(dir, n)).filter((p) => fs.statSync(p).isFile())
        files.sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs)
        resolve({ ...r, files, stderr: trunc(stderr, 4000), durationMs: Date.now() - t0 })
      } catch (e) {
        resolve({ ...r, files: [], stderr: trunc(stderr + '\n' + (e?.message || ''), 4000), durationMs: Date.now() - t0 })
      }
    }
    try {
      proc = spawn(ytDlpBin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      return done({ ok: false, error: String(e?.message || e) })
    }
    // 超时标志：killer 与 close 共享，否则 SIGKILL 触发的 close 会把超时误报成「下载失败」
    // （消费点第 230 行按 res.timedOut 区分「下载超时」与「下载失败」）。
    let timedOut = false
    let fallback
    const timer = setTimeout(() => { timedOut = true; try { proc.kill('SIGKILL') } catch { /* noop */ } }, ms)
    proc.stdout?.on('data', () => {}) // 进度行不累积（省内存）
    proc.stderr?.on('data', (d) => { stderr += d.toString() })
    proc.on('error', (e) => { clearTimeout(timer); clearTimeout(fallback); done({ ok: false, error: String(e?.message || e) }) })
    proc.on('close', (code) => {
      clearTimeout(timer)
      clearTimeout(fallback)
      done({ ok: !timedOut && code === 0, exitCode: code, timedOut })
    })
    // 超时分支：close 未按时到达时的兜底收尾
    fallback = setTimeout(() => { timedOut = true; try { if (!proc.killed) proc.kill('SIGKILL') } catch { /* noop */ } ; done({ ok: false, timedOut: true }) }, ms + 500)
  })
}

/**
 * 用 yt-dlp 下载（**沙箱档**，agent.sandbox.mode=e2b）：沙箱内执行 + 结果流式拉回宿主目录。
 * @returns {Promise<{ok, files:[abs], stderr, durationMs, sandboxed:true, timedOut?, error?}>}
 */
export async function runYtDlpInSandbox(box, url, opts = {}) {
  const {
    dir,
    format = 'best[ext=mp4]/best',
    audioOnly = false,
    maxBytes = 600 * MB,
    timeoutSec = 600,
    mergeFormat = 'mp4',
    signal = null,
  } = opts
  const t0 = Date.now()
  const remoteDir = sandboxTmp('dl')
  const outTmpl = `${remoteDir}/%(title).80B.%(ext)s`
  const args = buildYtDlpArgs(url, { outTmpl, format, audioOnly, maxBytes, mergeFormat })
  const cmd = `mkdir -p ${shellQuote(remoteDir)} && yt-dlp ${args.map((a) => shellQuote(a)).join(' ')}`
  const sess = await openToolSession(box, { purpose: 'tool:web_download' })
  const r = await runToolCommand(box, sess, cmd, {
    timeoutMs: Math.min(timeoutSec, box.maxTimeout) * 1000,
    maxOutput: 4000,
    signal,
    label: 'web_download',
  })
  const durationMs = Date.now() - t0
  const base = { ok: false, files: [], stderr: trunc(r.stderr || '', 4000), durationMs, sandboxed: true }

  if (r.limited) return { ...base, error: r.error }
  const miss = missingCommand('yt-dlp', r, 'web_download')
  if (miss) return { ...base, error: miss.error }
  if (r.timedOut) return { ...base, timedOut: true }
  if (r.sandboxError || r.error) return { ...base, error: `沙箱执行失败（${r.sandboxError?.kind || 'unknown'}）：${String(r.stderr || '').slice(0, 200)}` }
  if (!r.ok) return { ...base, exitCode: r.exitCode }

  // 收集产物：列目录 → 取最大文件 → 流式拉回宿主（不整块进内存）
  let files = []
  try {
    const entries = await sess.list(remoteDir, { depth: 1 })
    files = (entries || []).filter((e) => (e?.type || 'file') === 'file' && e?.name && !String(e.name).endsWith('.part')).map((e) => ({ name: e.name, size: Number(e.size) || 0 })).sort((a, b) => b.size - a.size)
  } catch (e) {
    return { ...base, error: `沙箱产物列目录失败：${e?.message || e}` }
  }
  const picked = files[0]
  if (!picked) return { ...base, error: '下载失败（沙箱内未产出文件）' }
  const hostPath = path.join(dir, path.basename(picked.name))
  // 拉回上限：yt-dlp 的 --max-filesize 按单流限制，合并（video+audio mux）后可能略超 → 留 64MB 余量
  const transferCap = maxBytes + 64 * MB
  try {
    await sess.downloadTo(`${remoteDir}/${picked.name}`, hostPath, { maxBytes: transferCap, signal })
  } catch (e) {
    return { ...base, error: `拉回沙箱文件失败：${e?.message || e}` }
  }
  // 沙箱内临时文件仅本次使用：拉回成功后清理（失败不影响结果；同样计入命令数/审计）
  try { await runToolCommand(box, sess, `rm -rf ${shellQuote(remoteDir)}`, { timeoutMs: 15000, maxOutput: 500, label: 'web_download:cleanup' }) } catch { /* noop */ }
  return { ...base, ok: true, files: [hostPath], durationMs: Date.now() - t0 }
}

/**
 * 构造 web_download 工具。
 * ctx.download = { dir?, maxBytes?, maxTimeoutSec?, sendLimitBytes?, ytDlpBin? }（可被 config 覆盖）
 */
export function makeDownloadTool({ ytDlpBin } = {}) {
  return {
    name: 'web_download',
    description: '从网站下载视频/音频/媒体文件（基于 yt-dlp，支持 YouTube/B站/抖音/西瓜/微博 等 1000+ 站点）。需要下载视频时优先用本工具，不要用 terminal 跑 curl/wget/yt-dlp。下完会自动把文件发到当前会话并清理临时文件。仅主人可用。',
    category: 'system',
    meta: { interactive: true, resultCap: 6000, effect: 'external', replay: 'never' },
    parameters: {
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string', description: '视频/媒体页面的 URL（http/https）' },
        audioOnly: { type: 'boolean', description: '只要音频（提取为 mp3）。默认 false（下载视频）' },
        format: { type: 'string', description: 'yt-dlp 格式选择串（可选，如 "best" / "bestvideo+bestaudio"）。留空=自动选最佳 mp4' },
      },
    },
    async execute(params = {}, ctx = {}) {
      const cfg = ctx?.download || {}
      const url = String(params.url || '').trim()
      // ① URL 校验：仅 http(s)
      if (!/^https?:\/\//i.test(url)) return { error: '仅支持 http/https URL' }
      if (/\s|--|\bsource=|\bexec\b/i.test(url)) return { error: 'URL 含可疑字符' }

      const bin = ytDlpBin || cfg.ytDlpBin || 'yt-dlp'
      const baseDir = cfg.dir || path.join(Config.path.temp, 'downloads')
      const callDir = path.join(baseDir, `${Date.now()}-${randomUUID().slice(0, 8)}`)
      const maxBytes = Number(cfg.maxBytes) || 600 * MB
      const sendLimit = Number(cfg.sendLimitBytes) || 100 * MB
      const timeoutSec = Number(cfg.maxTimeoutSec) || 600
      fs.mkdirSync(callDir, { recursive: true })

      // ② 下载：显式选择 e2b → 沙箱档（拉回到 callDir）；否则宿主档
      const box = toolSandbox(ctx)
      let res
      if (box) {
        res = await runYtDlpInSandbox(box, url, {
          dir: callDir,
          format: params.format || undefined,
          audioOnly: params.audioOnly === true,
          maxBytes, timeoutSec,
          signal: ctx?.signal || null,
        }).catch((e) => ({ ok: false, error: String(e?.message || e), files: [], durationMs: 0, sandboxed: true }))
      } else if (sandboxSelected(ctx)) {
        return sandboxUnavailableError('web_download')
      } else {
        res = await runYtDlp(url, {
          dir: callDir, ytDlpBin: bin,
          format: params.format || undefined,
          audioOnly: params.audioOnly === true,
          maxBytes, timeoutSec,
        }).catch((e) => ({ ok: false, error: String(e?.message || e), files: [], durationMs: 0 }))
      }

      const file = (res.files || []).map((p) => ({ p, size: (() => { try { return fs.statSync(p).size } catch { return 0 } })() })).sort((a, b) => b.size - a.size)[0]

      // 失败 / 无文件
      if (!res.ok || !file) {
        try { fs.rmSync(callDir, { recursive: true, force: true }) } catch { /* noop */ }
        return {
          error: res.timedOut ? `下载超时（${timeoutSec}s）` : (res.error || '下载失败'),
          stderr: (res.stderr || '').split('\n').slice(-6).join('\n'),
          durationMs: res.durationMs,
        }
      }

      // ③ 太大不塞 QQ：返回路径（供 SFTP 取），并保留文件
      if (file.size > sendLimit) {
        return {
          ok: true, sent: false,
          file: path.basename(file.p), path: file.p, size: file.size,
          note: `文件 ${Math.round(file.size / MB)}MB 超过发送上限 ${Math.round(sendLimit / MB)}MB，未自动发送。可用 SFTP(sftpadmin) 取：${file.p}`,
          durationMs: res.durationMs,
        }
      }

      // ④ 发送到会话 + 清理
      try {
        const seg = toFileSegment(file.p, path.basename(file.p))
        const e = ctx?.e
        if (e?.reply) await e.reply(seg)
        else if (ctx?.bot?.pickGroup && ctx?.groupId) await ctx.bot.pickGroup(ctx.groupId).sendMsg(seg)
        else throw new Error('无可用的发送出口（缺 ctx.e/ctx.bot）')
        try { fs.rmSync(callDir, { recursive: true, force: true }) } catch { /* noop */ }
        return { ok: true, sent: true, file: path.basename(file.p), size: file.size, durationMs: res.durationMs }
      } catch (e) {
        Log.warn('[download] 发送失败', e?.message || e)
        return { ok: true, sent: false, file: path.basename(file.p), path: file.p, size: file.size, error: `已下载但发送失败：${e?.message || e}（可用 SFTP 取：${file.p}）`, durationMs: res.durationMs }
      }
    },
  }
}

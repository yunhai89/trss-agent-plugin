/**
 * 发送前高清化（HD voice）—— TTS 输出"偏轻"是普遍现象（实测比参考音频低 4~6dB），
 * 而"偏闷"因音色而异（有的参考克隆出来 4~8kHz 存在感低 ~9dB，有的基本正常）。
 * 因此：
 *   1) loudnorm 响度标准化到 I=-15 LUFS / 真峰 -2dB（语音聊天通用响度）——固定执行；
 *   2) 存在感补偿 —— **自适应**：先测 4~8kHz 相对 0~4kHz 的倾斜，只把不足的部分补到目标
 *      （-12dB 为自然语音典型值），增益夹在 0~+6dB（已经明亮的音色不叠加，避免刺耳/齿音）；
 *   3) 重采样对齐 24kHz 单声道 s16le（QQ/NapCat 语音目标参数，避免二次重采样）。
 *
 * 设计：任何一步失败都回退原始文件并记 warn——宿主没装 ffmpeg、测量失败等都不阻断发送。
 */
import fs from 'node:fs'
import { runFfmpeg } from './audio.js'

/** 固定响度段（导出供测试断言） */
export const HD_LOUDNORM = 'loudnorm=I=-15:TP=-2:LRA=11'
/** 存在感补偿目标（4~8k 相对 0~4k 的自然语音典型倾斜）与上限 */
export const PRESENCE_TARGET_DB = -12
export const PRESENCE_MAX_DB = 6

/** EQ 段（存在感补偿）；g=0 时等效不加色彩 */
export function presenceFilter(presenceDb = 0) {
  const g = Math.round((Number(presenceDb) || 0) * 10) / 10
  if (!g) return ''
  const shelf = Math.round(g * 0.8 * 10) / 10
  return `equalizer=f=4000:t=q:w=1.2:g=${g},highshelf=f=6000:g=${shelf}`
}

/** 响度段：拿到两遍测量值时走 linear（保动态、不抽气），否则退回单遍 */
export function loudnormFilter(loud) {
  if (!loud) return HD_LOUDNORM
  const f = (v) => Number(v).toFixed(2)
  return `${HD_LOUDNORM}:measured_I=${f(loud.i)}:measured_TP=${f(loud.tp)}:measured_LRA=${f(loud.lra)}:measured_thresh=${f(loud.thresh)}:offset=${f(loud.offset)}:linear=true`
}

/**
 * 按存在感增益 + 响度测量构造滤镜链：**先 EQ 后响度**。
 * 顺序很关键：旧实现把 EQ 放在 loudnorm 之后，补偿 +4dB 会把真峰从 -1.5dB 顶到 -0.9dBFS，
 * 近削顶的齿音听起来发炸/发塑料 —— 这正是「高清增强后更奇怪」的主因。
 */
export function hdFilter(presenceDb = 0, loud = null) {
  return [presenceFilter(presenceDb), loudnormFilter(loud)].filter(Boolean).join(',')
}

export function buildEnhanceArgs(inputPath, outputPath, presenceDb = 0, loud = null) {
  return ['-y', '-i', String(inputPath), '-af', hdFilter(presenceDb, loud), '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', String(outputPath)]
}

/** 增强输出路径：<原名>.hd.wav（与源文件同目录，便于统一清理） */
export function hdOutputPath(inputPath) {
  return String(inputPath).replace(/\.[a-z0-9]+$/i, '') + '.hd.wav'
}

/** 倾斜差值 → 增益：只补不足，0~+6dB 夹取（测量不可用返回 0=不加色彩） */
export function presenceGainFor(ratioDb, target = PRESENCE_TARGET_DB, max = PRESENCE_MAX_DB) {
  if (ratioDb == null || !Number.isFinite(Number(ratioDb))) return 0
  return Math.max(0, Math.min(max, target - Number(ratioDb)))
}

/** 用 ffmpeg volumedetect 测 4~8k 相对 0~4k 的响度差（dB）；失败返回 null */
export async function measurePresenceRatio(inputPath, { runner = runFfmpeg, timeout = 20 } = {}) {
  const band = async (af) => {
    const r = await runner(['-hide_banner', '-i', String(inputPath), '-af', `${af},volumedetect`, '-f', 'null', '-'], { timeout })
    const m = String(r?.stderr || '').match(/mean_volume:\s*(-?[\d.]+)/)
    return m ? Number(m[1]) : null
  }
  const low = await band('lowpass=f=4000')
  const high = await band('highpass=f=4000,lowpass=f=8000')
  if (low == null || high == null) return null
  return high - low
}

/** 用 loudnorm 的 json 输出测当前响度，供第二遍 linear 归一化用；失败返回 null */
export async function measureLoudness(inputPath, { runner = runFfmpeg, timeout = 20 } = {}) {
  try {
    const r = await runner(['-hide_banner', '-nostats', '-i', String(inputPath), '-af', `${HD_LOUDNORM}:print_format=json`, '-f', 'null', '-'], { timeout })
    const text = String(r?.stderr || '')
    const m = text.match(/\{[\s\S]*"input_i"[\s\S]*\}/)
    if (!m) return null
    const j = JSON.parse(m[0])
    const num = (k) => {
      const v = Number(j[k])
      return Number.isFinite(v) && v > -1e9 ? v : null
    }
    const out = { i: num('input_i'), tp: num('input_tp'), lra: num('input_lra'), thresh: num('input_thresh'), offset: num('target_offset') }
    return Object.values(out).every((v) => v != null) ? out : null
  } catch {
    return null
  }
}

/**
 * 高清化音频；成功返回 { ok:true, path, presenceDb }，失败/未启用由调用方回退。
 * @param {string} inputPath 已合成的音频（wav/mp3）
 * @param {object} opts { runner, timeout, logger, presenceDb } —— presenceDb 显式指定时跳过测量
 */
export async function enhanceVoice(inputPath, { runner = runFfmpeg, timeout = 90, logger, presenceDb } = {}) {
  const out = hdOutputPath(inputPath)
  try {
    let gain = presenceDb
    const [ratio, loud] = await Promise.all([
      gain == null ? measurePresenceRatio(inputPath, { runner }) : Promise.resolve(null),
      measureLoudness(inputPath, { runner }),
    ])
    if (gain == null) {
      gain = presenceGainFor(ratio)
      logger?.('debug', `[tts] 高清增强：存在感倾斜 ${ratio == null ? '未知' : ratio.toFixed(1) + 'dB'} → 补偿 +${gain}dB`)
    }
    const r = await runner(buildEnhanceArgs(inputPath, out, gain, loud), { timeout })
    if (r?.ok && fs.existsSync(out) && fs.statSync(out).size > 44) return { ok: true, path: out, presenceDb: gain }
    logger?.('warn', '[tts] 高清增强失败（回退原始音频）', String(r?.stderr || r?.error || '输出无效').slice(-160))
    try { fs.unlinkSync(out) } catch { /* noop */ }
    return { ok: false, path: inputPath }
  } catch (e) {
    logger?.('warn', '[tts] 高清增强异常（回退原始音频）', e?.message || e)
    return { ok: false, path: inputPath }
  }
}

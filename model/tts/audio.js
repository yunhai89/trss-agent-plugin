/**
 * max 档音频合成 —— 把逐段生成的 wav 按顺序拼接为一段 mp3（段间可插静音）。
 *
 * 采用 ffmpeg concat demuxer（-f concat -safe 0）+ 重编码 mp3：
 *  - 各段均来自同一 IndexTTS 实例（22050Hz 单声道），流参数一致，concat 安全；
 *  - 静音段用 anullsrc 生成同参数 wav，保证 concat 兼容；
 *  - 输出 mp3 便于 OneBot 协议端（NapCat 等）转 silk 发送，体积也远小于 wav。
 *
 * 执行一律 argv 数组 + shell:false（路径按字面传递，不做 shell 拼接）；runner 可注入便于离线自检。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'

/** 默认 ffmpeg 执行器（与 model/document/media_stt.js 同语义：argv 数组、shell:false） */
export function runFfmpeg(args, { timeout = 120, maxOutput = 8000 } = {}) {
  return new Promise((resolve) => {
    try {
      execFile('ffmpeg', args, { timeout: (Number(timeout) || 120) * 1000, maxBuffer: (maxOutput || 8000) * 1024 }, (err, stdout, stderr) => {
        resolve({
          ok: !err,
          exitCode: err ? (Number.isFinite(err.code) ? err.code : 1) : 0,
          stdout: String(stdout || '').slice(-maxOutput),
          stderr: String(stderr || '').slice(-maxOutput),
          signal: err?.signal || null,
        })
      })
    } catch (e) {
      resolve({ ok: false, exitCode: null, stdout: '', stderr: `execFile 失败：${e?.message || e}`, signal: null })
    }
  })
}

/** 静音 wav 生成参数 */
export function buildSilenceArgs(outPath, ms) {
  const sec = Math.max(0, Number(ms) || 0) / 1000
  return ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=22050:cl=mono', '-t', sec.toFixed(3), '-c:a', 'pcm_s16le', String(outPath)]
}

/** concat demuxer 列表文件内容（单引号转义：内部 ' → '\''） */
export function buildConcatListContent(files) {
  return files.map((f) => `file '${String(f).replace(/'/g, "'\\''")}'`).join('\n') + '\n'
}

/** concat 参数（重编码 mp3） */
export function buildConcatArgs(listPath, outPath) {
  return ['-y', '-f', 'concat', '-safe', '0', '-i', String(listPath), '-codec:a', 'libmp3lame', '-q:a', '4', String(outPath)]
}

/**
 * 拼接分段音频。
 * @param {string[]} files 段文件路径（按顺序）
 * @param {string} outPath 输出 mp3 路径
 * @param {object} opts { gapMs 段间静音毫秒(默认300,0=不加), tempDir, runner, timeout, logger }
 * @returns {Promise<{ok:boolean, outPath?:string, error?:string, stderr?:string}>}
 */
export async function concatSegments(files, outPath, { gapMs = 300, tempDir, runner = runFfmpeg, timeout = 120, logger } = {}) {
  const list = (files || []).filter(Boolean)
  if (!list.length) return { ok: false, error: '没有可拼接的音频段' }
  if (list.length === 1) {
    // 单段无需 concat：直接原样返回，由调用方决定是否转码/发送
    return { ok: true, outPath: list[0], single: true }
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  const tmp = tempDir || path.dirname(outPath)
  fs.mkdirSync(tmp, { recursive: true })
  let seq = []
  try {
    if (Number(gapMs) > 0) {
      const silence = path.join(tmp, `silence_${Number(gapMs)}ms.wav`)
      if (!fs.existsSync(silence)) {
        const r = await runner(buildSilenceArgs(silence, gapMs), { timeout: 30 })
        if (!r.ok) {
          logger?.('warn', '[tts] 静音生成失败，拼接时不插段间静音', (r.stderr || '').slice(-160))
        }
      }
      if (fs.existsSync(silence)) {
        for (let i = 0; i < list.length; i++) {
          seq.push(list[i])
          if (i < list.length - 1) seq.push(silence)
        }
      }
    }
    if (!seq.length) seq = list.slice()
    const listPath = path.join(tmp, `concat_${Date.now()}_${process.pid}.txt`)
    fs.writeFileSync(listPath, buildConcatListContent(seq))
    const r = await runner(buildConcatArgs(listPath, outPath), { timeout })
    try { fs.unlinkSync(listPath) } catch { /* noop */ }
    if (!r.ok) return { ok: false, error: `ffmpeg 拼接失败（exit ${r.exitCode ?? '?'}）：${(r.stderr || '').slice(-200) || r.signal || '未知错误'}`, stderr: r.stderr }
    return { ok: true, outPath }
  } catch (e) {
    return { ok: false, error: `拼接异常：${e?.message || e}` }
  }
}

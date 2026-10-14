/**
 * Python 精确计算工具（calculate）。
 *
 * 模型遇到数学/统计/大数/复杂公式/单位换算等问题时，调用本工具写 Python 代码本地执行，
 * 拿到准确数值结果，避免模型自身心算出错（大数乘除、浮点、开方、统计等极易算错）。
 *
 * 安全：在受限沙箱内执行——
 *  - 仅允许 import 白名单模块（math/statistics/decimal/fractions/itertools/json/datetime/re/cmath）
 *  - 禁用 open/exec/eval/compile/getattr 等危险内建 + 网络无关、无文件系统
 *  - 子进程隔离 + 超时（默认 10s）防死循环
 *  预导入常用数学库，用户代码直接用 math.sqrt / statistics.mean 等，用 print() 输出答案。
 *  注：宿主档非 hardened 沙箱（对象子类遍历类逃逸理论上存在），面向可信模型做数学计算；
 *  **显式选择 E2B（agent.sandbox.mode=e2b）时改在会话沙箱内执行**（模型提交的代码不落宿主）——
 *  沙箱不可用则 fail-closed 拒绝，绝不回落宿主；沙箱内用 `python3`（模板自带）。
 *
 * 依赖：python3（宿主档：本机/容器需装；沙箱档：E2B 模板需含 python3）。缺失时工具返回明确提示。
 */

import { spawn } from 'node:child_process'
import Config from '../../utils/Config.js'
import { toolSandbox, sandboxSelected, sandboxUnavailableError, openToolSession, runToolCommand, missingCommand, sandboxTmp, shellQuote } from '../sandbox/bridge.js'

/** 沙箱 wrapper（固定，以 `python3 -c` 运行；用户代码经 stdin 传入，无转义问题） */
const SANDBOX = `import sys, builtins as _B, math, statistics, decimal, fractions, itertools, json, datetime, random, re, cmath
_ALLOWED = {'math','statistics','decimal','fractions','itertools','json','datetime','random','re','cmath'}
_DANGEROUS = {'open','exec','eval','compile','exit','quit','input','breakpoint','globals','locals','vars','dir','getattr','setattr','delattr','memoryview','help','license','copyright','credits'}
_b = {k: v for k, v in _B.__dict__.items() if k not in _DANGEROUS}
_oi = _b.get('__import__')
def _si(name, *a, **k):
    root = name.split('.')[0]
    if root not in _ALLOWED:
        raise ImportError("module '%s' not allowed (calc sandbox: math/stats only)" % name)
    return _oi(name, *a, **k)
_b['__import__'] = _si
_ns = {'__builtins__': _b, 'math': math, 'statistics': statistics, 'decimal': decimal, 'fractions': fractions, 'itertools': itertools, 'json': json, 'datetime': datetime, 'random': random, 're': re, 'cmath': cmath}
exec(sys.stdin.read(), _ns)`

/**
 * 在沙箱里执行 Python 代码。
 * @returns {ok, exitCode, stdout, stderr, missing?, timedOut?}
 */
export function runPython(code, { python = 'python3', timeout = 10000 } = {}) {
  return new Promise((resolve) => {
    let stdout = '', stderr = ''
    let timer = null
    let proc
    const finish = (r) => { if (timer) clearTimeout(timer); resolve(r) }
    try {
      proc = spawn(python, ['-c', SANDBOX], { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) {
      return finish({ ok: false, missing: true, stderr: String(e) })
    }
    timer = setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* noop */ } finish({ ok: false, timedOut: true, stdout, stderr }) }, timeout)
    proc.stdin?.on('error', () => { /* noop */ })
    try { proc.stdin.write(String(code || '')); proc.stdin.end() } catch { /* noop */ }
    proc.stdout?.on('data', (d) => { stdout += d.toString() })
    proc.stderr?.on('data', (d) => { stderr += d.toString() })
    proc.on('error', (e) => {
      const missing = /ENOENT|not found|spawn/i.test(e?.message || '')
      finish({ ok: false, missing, stderr: stderr + `\n${e?.message || e}` })
    })
    proc.on('close', (code2) => finish({ ok: code2 === 0, exitCode: code2, stdout, stderr }))
  })
}

export const calcTool = {
  name: 'calculate',
  description: [
    '执行 Python 代码做精确数值计算（数学/统计/单位换算/大数/复杂公式/日期差/财务利率等）。',
    '何时用：需要精确数字结果、或避免自身心算出错时（大数乘除、浮点、开方、组合数、均值方差、复利等模型易算错的场景）。',
    '已预导入 math / statistics / decimal / fractions / itertools / json / datetime / re / cmath，直接用（如 math.sqrt、statistics.mean、decimal.Decimal），无需 import；用 print() 输出最终答案。',
    '仅限数值/数据处理，禁止任何文件/网络/系统操作。',
  ].join(''),
  category: 'query',
  meta: { summary: 'Python 精确计算', resultCap: 4000 },
  parameters: {
    type: 'object',
    properties: { code: { type: 'string', description: 'Python 计算代码（用 print() 输出结果）' } },
    required: ['code'],
  },
  async execute(params, ctx = {}) {
    const cfg = Config.get?.().agent?.calc || {}
    const timeoutMs = (cfg.timeout ?? 10) * 1000
    const code = String(params?.code || '')

    // 沙箱档（agent.sandbox.mode=e2b）：模型提交的代码在会话沙箱内执行
    const box = toolSandbox(ctx)
    if (box) {
      let r
      try { r = await runCalcInSandbox(box, code, { timeoutMs, signal: ctx?.signal }) } catch (e) { return { error: `沙箱执行失败：${e?.message || e}` } }
      if (r.error) return { error: r.error }
      const miss = missingCommand('python3', r, 'calculate')
      if (miss) return miss
      if (r.timedOut) return { error: '计算超时（疑似死循环或计算量过大），请简化/拆分代码后重试。' }
      if (r.aborted) return { error: '计算已取消' }
      const out = (r.stdout || '').trim()
      if (!r.ok) return { error: tailOf(r.stderr) || '沙箱内执行失败' }
      return { ok: true, result: out || '(无输出——请用 print() 输出计算结果)', sandboxed: true }
    }
    // 显式选择 e2b 但沙箱未就绪：fail-closed（绝不在宿主跑模型提交的代码）
    if (sandboxSelected(ctx)) return sandboxUnavailableError('calculate')

    // 宿主档（mode=off / 未配置沙箱）：本机受限解释器，行为与旧版一致
    const r = await runPython(code, {
      python: cfg.python || 'python3',
      timeout: timeoutMs,
    })
    if (r.missing) return { error: `python3 不可用（${cfg.python || 'python3'} 未安装/不在 PATH）。请在运行环境安装 python3 后重试。` }
    if (r.timedOut) return { error: '计算超时（疑似死循环或计算量过大），请简化/拆分代码后重试。' }
    const out = (r.stdout || '').trim()
    if (!r.ok) return { error: tailOf(r.stderr) }
    return { ok: true, result: out || '(无输出——请用 print() 输出计算结果)' }
  },
}

/** stderr 末尾几行（traceback 最有用的部分） */
function tailOf(stderr) {
  return String(stderr || '执行失败').trim().split('\n').filter(Boolean).slice(-4).join('\n')
}

/**
 * 沙箱档执行：上传固定 wrapper + 用户代码两个文件，用 stdin 重定向喂给 wrapper
 * （与宿主档同一套限制内建；用户代码不经过命令行拼接，无转义/注入面）。
 * @returns {Promise<{ok, exitCode, stdout, stderr, timedOut?, aborted?, limited?, error?}>}
 */
async function runCalcInSandbox(box, code, { timeoutMs = 10000, signal = null } = {}) {
  const dir = sandboxTmp('calc')
  const sess = await openToolSession(box, {
    purpose: 'tool:calculate',
    files: [
      { path: `${dir}/wrapper.py`, data: SANDBOX },
      { path: `${dir}/code.py`, data: String(code || '') },
    ],
  })
  const r = await runToolCommand(box, sess, `python3 ${shellQuote(`${dir}/wrapper.py`)} < ${shellQuote(`${dir}/code.py`)}`, {
    timeoutMs: Math.min(timeoutMs, box.maxTimeout * 1000),
    maxOutput: 8000,
    signal,
    label: 'calculate',
  })
  if (r.limited) return { ok: false, error: r.error }
  if (r.sandboxError || r.error) {
    return { ok: false, error: `沙箱执行失败（${r.sandboxError?.kind || 'unknown'}）：${String(r.stderr || '').slice(0, 200)}` }
  }
  return {
    ok: r.ok === true,
    exitCode: r.exitCode,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    timedOut: r.timedOut === true,
    aborted: r.aborted === true,
  }
}

/**
 * install_skill —— 「受控」技能安装器（SkillHub）。
 *
 * 执行面（2025-10 变更）：显式选择 E2B（agent.sandbox.mode=e2b）后，`skillhub install` **在会话沙箱内执行**
 * （第三方 CLI 不在宿主跑），产物经文件通道**只回传 .md 指令文件**（其余类型/符号链接/隐藏项一律拒绝），
 * 落 staging 校验通过后才进宿主 skills/ 目录并热加载；沙箱不可用或模板缺 skillhub 时结构化失败。
 * mode=off（未配置沙箱）时保持旧的宿主侧执行路径。
 *
 * 安全设计（feature-security-assessment：有条件通过）：
 *   1. 仅主人（category:'system' + execute 内显式 isMaster 复核）；alwaysConfirm 防 prompt 注入静默安装。
 *   2. **不跑任意 shell**：宿主档 execFile('skillhub', ['install', name, '--dir', skillsDir]) 固定 argv、无 shell 拼接；
 *      沙箱档同为固定拼装（name 过严格白名单 + shellQuote 双保险）；目标目录来自配置、不接受用户传入。
 *   3. **不自动下载/执行远程安装脚本**：CLI 需由运维预先安装（宿主档装宿主、沙箱档装模板；工具只调用）。
 *   4. **安装产物强校验（fail-closed）**：仅允许 .md 指令文件（**拒绝 .js/.mjs/.cjs/.ts/.sh 等可执行文件**，
 *      否则 loadSkillPack 会 import() 顶层 .js → 宿主任意代码执行）；拒绝符号链接/隐藏文件/特殊文件；
 *      限制文件数/总大小/目录数；校验任一不通过即清理 staging、不动 skillsDir。
 *   5. 技能正文属不可信内容，加载后由 Agent 的 tool 结果/技能目录注入筛查（screenUntrusted）加边界标注。
 *   6. 审计日志只记 name/结果，不含敏感信息。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { loadSkillPack } from './index.js'
import { toolSandbox, sandboxSelected, sandboxUnavailableError, openToolSession, runToolCommand, shellQuote } from '../sandbox/bridge.js'

const execFileP = promisify(execFile)

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const ALLOWED_FILE_RE = /\.md$/i
const MAX_FILES = 200
const MAX_DIRS = 50
const MAX_BYTES = 5 * 1024 * 1024 // 5MB
const INSTALL_TIMEOUT_MS = 120000
const MAX_OUTPUT = 1024 * 1024

/** 传给 CLI 的最小环境（保留 PATH/HOME/临时目录/代理，避免把全部环境变量暴露给子进程） */
function childEnv() {
  const e = {}
  for (const k of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) {
    if (process.env[k] != null) e[k] = process.env[k]
  }
  return e
}

/** 递归校验安装产物：返回错误数组（空=通过）。拒绝一切非 .md 文件/符号链接/隐藏项/超限。 */
export function validateSkillArtifact(root) {
  let lst
  try { lst = fs.lstatSync(root) } catch { return ['产物不存在'] }
  if (lst.isSymbolicLink()) return ['不允许符号链接']
  if (lst.isFile()) {
    if (!ALLOWED_FILE_RE.test(root)) return ['仅允许 .md 技能文件']
    if (lst.size > MAX_BYTES) return ['文件超过大小上限']
    return []
  }
  if (!lst.isDirectory()) return ['产物类型非法（既非文件也非目录）']

  const base = path.resolve(root)
  const stack = [base]
  let files = 0
  let dirs = 0
  let bytes = 0
  let md = 0
  while (stack.length) {
    const d = stack.pop()
    dirs++
    if (dirs > MAX_DIRS) return ['目录数超过上限']
    const resolved = path.resolve(d)
    if (resolved !== base && !resolved.startsWith(base + path.sep)) return ['路径越界（疑似目录穿越）']
    let ents
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return [`无法读取目录：${d}`] }
    for (const ent of ents) {
      const full = path.join(d, ent.name)
      let st
      try { st = fs.lstatSync(full) } catch { return [`无法读取：${ent.name}`] }
      if (st.isSymbolicLink()) return [`含符号链接：${ent.name}`]
      if (ent.name.startsWith('.')) return [`含隐藏文件/目录：${ent.name}`]
      if (st.isDirectory()) { stack.push(full); continue }
      if (!st.isFile()) return [`含特殊文件：${ent.name}`]
      if (!ALLOWED_FILE_RE.test(ent.name)) return [`不允许的文件类型：${ent.name}（仅允许 .md；拒绝可执行/脚本/二进制）`]
      files++
      bytes += st.size
      md++
      if (files > MAX_FILES) return ['文件数超过上限']
      if (bytes > MAX_BYTES) return ['总大小超过上限']
    }
  }
  if (!md) return ['未找到 .md 指令文件（技能包为空或不合法）']
  return []
}

function rmEntry(p) {
  try { fs.rmSync(p, { recursive: true, force: true }) } catch { /* noop */ }
}

/** 安装后热加载（两档共用；失败不抛，返回可读错误让用户 reload_skills 兜底） */
async function reloadInstalledSkills(skillsDir, registry, logger) {
  try {
    const fresh = await loadSkillPack(skillsDir, { logger })
    registry?.skills?.clear?.()
    registry?.register?.(...fresh)
    return { count: registry?.list?.().length ?? fresh.length }
  } catch (e) {
    logger('error', `[install_skill] 已安装但热加载失败：${e?.message || e}`)
    return { error: `技能已安装到 ${skillsDir}，但热加载失败：${e?.message || e}（可手动 reload_skills）` }
  }
}

/**
 * 沙箱档安装：沙箱内执行 skillhub → 只回传 .md（拒绝可执行/链接/隐藏/特殊文件）→ staging 校验 → 落地 skillsDir。
 * @param {object} box toolSandbox(ctx)
 * @param {{name:string, skillsDir:string, registry:object, logger?:Function, signal?:AbortSignal}} opt
 */
export async function installSkillInSandbox(box, { name, skillsDir, registry, logger = () => {}, signal = null } = {}) {
  const remoteRoot = '/home/user/skills-out'
  const sess = await openToolSession(box, { purpose: 'tool:install_skill' })

  // 1) 预检 CLI（沙箱内；不自动安装）
  const probe = await runToolCommand(box, sess, 'command -v skillhub >/dev/null 2>&1', { timeoutMs: 20000, maxOutput: 500, label: 'install_skill:probe' })
  if (probe.limited) return { error: probe.error }
  if (!probe.ok) {
    return { error: '沙箱内没有 `skillhub` CLI。请运维把它装进 agent.sandbox.template 指向的 E2B 模板后重试（显式选择 e2b 时不在宿主执行安装）。' }
  }

  // 2) 固定拼装执行安装（name 已过白名单正则，shellQuote 双保险）
  logger('info', `[install_skill] master=sandbox install ${name}`)
  const r = await runToolCommand(box, sess, `skillhub install ${shellQuote(name)} --dir ${shellQuote(remoteRoot)}`, {
    timeoutMs: INSTALL_TIMEOUT_MS, maxOutput: MAX_OUTPUT, signal, label: 'install_skill',
  })
  if (r.limited) return { error: r.error }
  if (r.sandboxError || r.error) return { error: `沙箱内安装失败（${r.sandboxError?.kind || 'unknown'}）：${String(r.stderr || '').slice(0, 300)}` }
  if (!r.ok) return { error: `skillhub install 失败（沙箱内，exit=${r.exitCode}）：${String(r.stderr || '').slice(0, 300)}` }

  // 3) 收集产物：只认普通 .md；符号链接/隐藏/穿越/其它类型一律拒绝（与宿主档同口径）
  let entries = []
  try { entries = await sess.list(remoteRoot, { depth: 6 }) } catch (e) { return { error: `读取沙箱产物失败：${e?.message || e}` } }
  const files = []
  let bytes = 0
  for (const e of entries || []) {
    const abs = String(e?.path || '')
    if (!abs.startsWith(remoteRoot + '/')) continue
    const rel = abs.slice(remoteRoot.length + 1)
    if (!rel) continue
    const segs = rel.split('/')
    if (segs.some((s) => !s || s === '.' || s === '..' || s.startsWith('.'))) return { error: `技能包含非法路径项：${rel}（拒绝隐藏/穿越项）` }
    const type = String(e?.type || 'file')
    if (type === 'symlink') return { error: `技能包含符号链接：${rel}（拒绝）` }
    if (type === 'dir') continue
    if (type !== 'file') return { error: `技能包含特殊文件：${rel}（拒绝）` }
    if (!ALLOWED_FILE_RE.test(rel)) return { error: `不允许的文件类型：${rel}（仅允许 .md；拒绝可执行/脚本/二进制）` }
    bytes += Number(e?.size) || 0
    if (files.length + 1 > MAX_FILES) return { error: '文件数超过上限' }
    if (bytes > MAX_BYTES) return { error: '总大小超过上限' }
    files.push({ rel, abs })
  }
  if (!files.length) return { error: '未发现安装产物（技能名是否正确？）' }

  // 4) 拉回 staging → 校验全部通过才触碰 skillsDir（fail-closed）
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skillhub-'))
  try {
    for (const f of files) {
      const buf = await sess.read(f.abs, { binary: true })
      const dst = path.join(stagingRoot, f.rel)
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      fs.writeFileSync(dst, buf)
    }
    const tops = [...new Set(files.map((f) => f.rel.split('/')[0]))]
    const problems = []
    for (const top of tops) {
      const errs = validateSkillArtifact(path.join(stagingRoot, top))
      if (errs.length) problems.push(`${top}: ${errs.join('；')}`)
    }
    if (problems.length) {
      logger('error', `[install_skill] ${name} 校验不通过，已拒绝（staging 清理，skillsDir 未触碰）：${problems.join(' | ')}`)
      return { error: `技能包校验不通过，已拒绝并清理（仅允许纯 .md 指令技能）：${problems.join(' | ')}` }
    }

    const moved = []
    tops.forEach((top, i) => {
      const src = path.join(stagingRoot, top)
      const dst = path.join(skillsDir, top)
      const incoming = path.join(skillsDir, `.incoming-${Date.now().toString(36)}-${i}`)
      try {
        try { fs.renameSync(src, incoming) } catch (e) { if (e?.code === 'EXDEV') { fs.cpSync(src, incoming, { recursive: true }) } else { throw e } }
        rmEntry(dst) // 同名更新：先移除旧版（沙箱档 staging 已校验完成）
        fs.renameSync(incoming, dst)
        moved.push(top)
      } finally { rmEntry(incoming) }
    })

    // 5) 热加载（重扫宿主技能目录）
    const reload = await reloadInstalledSkills(skillsDir, registry, logger)
    if (reload.error) return { ok: false, error: reload.error, installed: moved, sandboxed: true }
    logger('info', `[install_skill] ${name} 沙箱安装成功，技能总数=${reload.count}`)
    return { ok: true, name, installed: moved, skillsCount: reload.count, sandboxed: true }
  } catch (e) {
    return { error: `沙箱安装产物落地失败：${e?.message || e}` }
  } finally {
    rmEntry(stagingRoot)
  }
}

/**
 * 构造 install_skill 工具。
 * @param {object} opts { skillsDir, registry, logger? }
 */
export function makeInstallSkillTool({ skillsDir, registry, logger = () => {} } = {}) {
  return {
    name: 'install_skill',
    description: '从 SkillHub(skillhub.cn) 安装一个技能到本机插件技能目录（受控执行：宿主档固定 argv 调 skillhub；启用 E2B 沙箱时在沙箱内安装并只回传 .md）。仅主人可用，需二次确认。'
      + '前提：对应执行面已由运维装好 `skillhub` CLI（本工具不自动下载安装脚本）。只接受纯 .md 指令技能，'
      + '含脚本/可执行/符号链接的包会被拒绝并清理。安装成功后自动热加载。',
    category: 'system', // 角色阶梯：system 需 master（policy.js CATEGORY_MIN.system=3）
    meta: { summary: '安装SkillHub技能', dangerous: true, interactive: true, alwaysConfirm: true },
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '要安装的技能名（SkillHub 上的包名，如 find-skill-skillhub）' },
      },
      required: ['name'],
    },
    async execute(params = {}, ctx = {}) {
      // 对象级授权复核（category=system 已挡低权限，但显式再确认主人身份，防策略覆盖/旁路）
      if (!ctx?.isMaster) return { error: '仅主人可安装技能' }
      const name = String(params.name || '').trim()
      if (!NAME_RE.test(name)) return { error: '技能名不合法（仅允许字母/数字/._-，长度 1-64，且不以符号开头）' }
      if (!skillsDir || !fs.existsSync(skillsDir)) return { error: `技能目录不存在：${skillsDir}` }

      // 执行面：显式选择 e2b → 沙箱档（第三方 CLI 不在宿主跑）；未就绪则 fail-closed
      const box = toolSandbox(ctx)
      if (box) {
        const r = await installSkillInSandbox(box, { name, skillsDir, registry, logger: (lvl, m) => logger(lvl, m), signal: ctx?.signal || null })
          .catch((e) => ({ error: `沙箱内安装失败：${e?.message || e}` }))
        return r
      }
      if (sandboxSelected(ctx)) return sandboxUnavailableError('install_skill（技能安装）')

      // 1) 预检 CLI（不装、不跑远程脚本）
      try {
        await execFileP('skillhub', ['--version'], { timeout: 10000, maxBuffer: 64 * 1024, env: childEnv() })
      } catch (e) {
        if (e?.code === 'ENOENT') {
          return { error: '宿主机未安装 skillhub CLI。请运维先在宿主机安装（本工具不自动执行远程安装脚本），再重试。' }
        }
        // 有 CLI 但 --version 非零：继续尝试 install（部分版本无 --version），不阻断
        logger('warn', `[install_skill] skillhub --version 异常（继续）：${e?.message || e}`)
      }

      // 2) 快照 → 固定 argv 执行 install（无 shell）
      const before = new Set(fs.readdirSync(skillsDir))
      logger('info', `[install_skill] master=${ctx.userId || ''} install ${name}`)
      let runErr = null
      try {
        await execFileP('skillhub', ['install', name, '--dir', skillsDir], {
          timeout: INSTALL_TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT,
          env: childEnv(),
          cwd: skillsDir,
        })
      } catch (e) {
        runErr = e
      }

      // 3) 收集产物（新增项 + 同名项，兼容「目录型 <name>/」与「扁平 <name>.md」）
      const after = fs.readdirSync(skillsDir)
      const added = after.filter((x) => !before.has(x))
      const candidates = new Set(added)
      for (const p of [name, `${name}.md`]) if (after.includes(p)) candidates.add(p)
      const candidatePaths = [...candidates].map((c) => path.join(skillsDir, c))

      if (runErr || !candidatePaths.length) {
        // 清理本次可能产生的残留（仅清理新增项，绝不碰已有技能）
        for (const c of added) rmEntry(path.join(skillsDir, c))
        const detail = runErr ? `skillhub install 失败：${String(runErr.message || runErr).slice(0, 300)}` : '未发现安装产物（技能名是否正确？）'
        logger('warn', `[install_skill] ${name} 失败：${detail}`)
        return { error: detail }
      }

      // 4) 强校验；任一不通过 → 删除全部本次产物、不加载（fail-closed）
      const problems = []
      for (const cp of candidatePaths) {
        const errs = validateSkillArtifact(cp)
        if (errs.length) problems.push(`${path.basename(cp)}: ${errs.join('；')}`)
      }
      if (problems.length) {
        for (const c of candidates) rmEntry(path.join(skillsDir, c))
        logger('error', `[install_skill] ${name} 校验不通过，已清理：${problems.join(' | ')}`)
        return { error: `技能包校验不通过，已拒绝并清理（仅允许纯 .md 指令技能）：${problems.join(' | ')}` }
      }

      // 5) 热加载（重扫宿主技能目录）
      const reload = await reloadInstalledSkills(skillsDir, registry, logger)
      if (reload.error) return { ok: false, error: reload.error, installed: [...candidates] }
      logger('info', `[install_skill] ${name} 安装成功，技能总数=${reload.count}`)
      return { ok: true, name, installed: [...candidates], skillsCount: reload.count }
    },
  }
}

/**
 * install_skill —— 宿主侧「受控」技能安装器（SkillHub）。
 *
 * 背景：terminal 的唯一执行面是 E2B 隔离沙箱（独立 microVM/独立 FS），沙箱里 `skillhub install`
 * 只会写进沙箱、宿主 skills/ 目录看不到，也没有回传通道。故技能安装必须走宿主侧专用工具。
 *
 * 安全设计（feature-security-assessment：有条件通过）：
 *   1. 仅主人（category:'system' + execute 内显式 isMaster 复核）；alwaysConfirm 防 prompt 注入静默安装。
 *   2. **不跑任意 shell**：execFile('skillhub', ['install', name, '--dir', skillsDir])，固定 argv、无 shell 拼接；
 *      name 严格正则白名单（无空格/斜杠/元字符）；目标目录来自配置、不接受用户传入。
 *   3. **不自动下载/执行远程安装脚本**：CLI 需由运维预先安装（工具只调用，不 `curl|bash`）。
 *   4. **安装产物强校验（fail-closed）**：仅允许 .md 指令文件（**拒绝 .js/.mjs/.cjs/.ts/.sh 等可执行文件**，
 *      否则 loadSkillPack 会 import() 顶层 .js → 宿主任意代码执行）；拒绝符号链接/隐藏文件/特殊文件；
 *      限制文件数/总大小/目录数；校验任一不通过即删除产物、不加载。
 *   5. 技能正文属不可信内容，加载后由 Agent 的 tool 结果/技能目录注入筛查（screenUntrusted）加边界标注。
 *   6. 审计日志只记 name/结果，不含敏感信息。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { loadSkillPack } from './index.js'

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

/**
 * 构造 install_skill 工具。
 * @param {object} opts { skillsDir, registry, logger? }
 */
export function makeInstallSkillTool({ skillsDir, registry, logger = () => {} } = {}) {
  return {
    name: 'install_skill',
    description: '从 SkillHub(skillhub.cn) 安装一个技能到本机插件技能目录（宿主侧受控执行）。仅主人可用，需二次确认。'
      + '前提：宿主机已由运维安装好 `skillhub` CLI（本工具不自动下载安装脚本）。只接受纯 .md 指令技能，'
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
      let count = 0
      try {
        const fresh = await loadSkillPack(skillsDir, { logger })
        registry?.skills?.clear?.()
        registry?.register?.(...fresh)
        count = registry?.list?.().length ?? fresh.length
      } catch (e) {
        logger('error', `[install_skill] ${name} 已安装但热加载失败：${e?.message || e}`)
        return { ok: false, error: `技能已安装到 ${skillsDir}，但热加载失败：${e?.message || e}（可手动 reload_skills）`, installed: candidates } 
      }
      logger('info', `[install_skill] ${name} 安装成功，技能总数=${count}`)
      return { ok: true, name, installed: [...candidates], skillsCount: count }
    },
  }
}

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import plugin from '../../../lib/plugins/plugin.js'

let uping = false

/** 插件根目录（绝对路径）——不依赖进程 cwd，避免 pm2/外部启动 cwd 非 Yunzai 根时 git 在错误目录执行。 */
const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * agents-plugin 更新命令（参考 TRSS 标准更新模式，用 Bot.exec）。
 *   #agent更新 / #agent强制更新   拉取当前分支最新代码（强制=reset 到远端）；有改动时自动重启
 *   #agent版本                     最近一次提交时间
 *   #agent更新日志                 本次更新的提交记录
 * 仅主人可用。插件目录名 agents-plugin。
 */
export class AgentsUpdate extends plugin {
  constructor() {
    super({
      name: 'agent_更新',
      dsc: 'agents-plugin 更新',
      event: 'message',
      priority: 1000,
      rule: [
        { reg: '^#*(agent)(插件)?(强制)?更新$', fnc: 'update' },
        { reg: '^#?(agent)(插件)?版本$', fnc: 'pluginVersion' },
        { reg: '^#?(agent)(插件)?更新日志$', fnc: 'updateLog' },
      ],
    })
  }

  get quiet() {
    return /^#(全部)?(安?静)/.test(this.e.msg)
  }

  /** 始终在插件根目录执行 git（绝对 cwd）。 */
  exec(cmd, opts = {}) {
    return Bot.exec(cmd, { ...opts, cwd: PLUGIN_DIR })
  }

  async update() {
    if (!this.e.isMaster) {
      await this.reply('仅主人可用此指令')
      return false
    }
    if (uping) {
      await this.reply('正在更新，请稍候再试')
      return false
    }

    uping = true
    try {
      await this.runUpdate()
      if (this.isPkgUp) await this.updatePackage()
      if (this.isUp) this.restart()
    } catch (err) {
      logger.error('[agents-plugin] 更新失败:', err)
      await this.reply('更新失败，请查看控制台日志')
    } finally {
      uping = false
    }
    return true
  }

  async runUpdate() {
    const force = this.e.msg.includes('强制')
    const type = force ? '强制更新' : '更新'
    const branch = (await this.getBranch()) || 'master'
    const remote = (await this.getRemote(branch)) || 'origin'
    const target = `${remote}/${branch}`

    this.oldCommitId = await this.getCommitId()
    logger.mark(`[agents-plugin] 开始${type} agents-plugin（${target}）于 ${PLUGIN_DIR}`)
    if (!this.quiet) await this.reply(`开始${type} agents-plugin（${target}）`)

    // 先显式 fetch（不依赖 upstream 配置），fetch 失败按错误处理
    const fetched = await this.exec(`git fetch ${remote} --prune --tags`)
    if (fetched.error && !(await this.gitErr(fetched.stdout, fetched.error.message))) {
      logger.mark('[agents-plugin] fetch 失败，已中止')
      return false
    }

    // 预检未跟踪文件冲突（2026-10-17 审计 high）：未跟踪文件若与本轮**新增**的上游文件同名，
    // `git merge --ff-only` 会直接 Aborting（即使内容逐字节相同），而 `git stash push`（不带 -u）
    // 只暂存已跟踪文件 → 用户会卡在「更新失败 → 按提示 stash → 更新仍失败」的死循环里。
    // 这里提前把清单和可执行指令打给用户，别等 git 报错。
    const collisions = await this.untrackedCollisions(target)
    if (collisions.length && !force) {
      await this.reply(
        `⚠️ 更新被本地未跟踪文件挡住（共 ${collisions.length} 个，与本次新增的上游文件同名）：\n`
        + collisions.map((f) => `· ${f}`).join('\n') + '\n'
        + '未跟踪文件不在 git 版本控制里，`git stash`（不带 `-u`）不会暂存它们，必须显式处理：\n'
        + '· 想保住：在插件目录执行 `git stash push -u -m agents-update`，再发送 #agent更新（之后 `git stash pop`）\n'
        + '· 确认可丢：`git clean -n -- <上面的路径>` 预览，再用 `git clean -f -- <路径>` 删除\n'
        + '· 或发 #agent强制更新（会覆盖这些文件；插件会先备份到 data/backup/，但仍请自行核对）',
      )
      logger.mark(`[agents-plugin] 预检：${collisions.length} 个未跟踪文件与上游新增文件同名，已中止`)
      return false
    }
    if (collisions.length && force) {
      const saved = await this.backupUntracked(collisions)
      if (saved.dir) await this.reply(`已备份 ${saved.count} 个将被覆盖的未跟踪文件到 data/backup/${path.basename(saved.dir)}/`)
    }

    const cm = force ? `git reset --hard ${target}` : `git merge --ff-only ${target}`
    const ret = await this.exec(cm)
    if (ret.error && !(await this.gitErr(ret.stdout, ret.error.message))) {
      logger.mark('[agents-plugin] 更新失败')
      return false
    }

    const after = await this.getCommitId()
    const time = await this.getTime()
    if (after === this.oldCommitId) {
      if (!this.quiet) await this.reply(`agents-plugin 已是最新（${target} @ ${after}）\n最后更新时间：${time}`)
      logger.mark(`[agents-plugin] 已是最新（${target} @ ${after}）`)
      return true
    }

    this.isUp = true
    const changed = (await this.exec(`git diff --name-only ${this.oldCommitId} ${after}`)).stdout
    if (/(^|\n)package\.json($|\n)/.test(changed)) this.isPkgUp = true
    await this.reply(`agents-plugin 更新成功：${this.oldCommitId} → ${after}\n更新时间：${time}`)
    await this.sendLogForward(await this.getLogEntries(), { branch, after })
    logger.mark(`[agents-plugin] 更新成功 ${this.oldCommitId} → ${after}，最后更新时间：${time}`)
    return true
  }

  async pluginVersion() {
    if (!this.e.isMaster) return false
    const branch = (await this.getBranch()) || '?'
    const head = await this.getCommitId()
    const time = await this.getTime()
    await this.reply(`agents-plugin（${branch} @ ${head}）最后更新时间：${time}`)
    return true
  }

  async updateLog() {
    if (!this.e.isMaster) return false
    const branch = await this.getBranch()
    const entries = await this.getLogEntries()
    if (!entries.length) { await this.reply('暂无更新日志'); return true }
    await this.sendLogForward(entries, { branch })
    return true
  }

  /** 版本类型标签：master=稳定版；beta=beta 版；其余=分支名 */
  versionLabel(branch) {
    if (branch === 'master') return '稳定版'
    if (branch === 'beta') return 'beta 版'
    return branch ? `分支 ${branch}` : '未知版本'
  }

  /**
   * 更新日志以「合并转发聊天记录」发出：每条日志独立一条消息；
   * 卡片标题 / 节点昵称注明是稳定版还是 beta 更新。转发失败自动降级为文本。
   */
  async sendLogForward(entries, { branch, after } = {}) {
    const label = this.versionLabel(branch)
    const title = `agents-plugin · ${label} 更新日志${after ? `（${after}）` : ''}`
    const selfId = String(this.e.self_id || '')
    const nickname = `agents-plugin ${label}`
    const nodes = [{ message: `📦 ${title}`, nickname, user_id: selfId }]
    for (const line of entries) nodes.push({ message: String(line), nickname, user_id: selfId })

    let fwd = null
    const mk = (this.e.isGroup && this.e.group?.makeForwardMsg) ? this.e.group.makeForwardMsg.bind(this.e.group)
      : (this.e.friend?.makeForwardMsg) ? this.e.friend.makeForwardMsg.bind(this.e.friend)
        : (this.e.bot?.makeForwardMsg) ? this.e.bot.makeForwardMsg.bind(this.e.bot)
          : (typeof Bot !== 'undefined' && Bot.makeForwardMsg) ? Bot.makeForwardMsg.bind(Bot) : null
    if (mk) {
      // 优先带 title（部分适配器支持，可让卡片头直接显示版本类型）；不支持则退回无 title
      try { fwd = await mk(nodes, { title }) } catch { try { fwd = await mk(nodes) } catch { fwd = null } }
    }
    if (fwd) { await this.reply(fwd); return true }
    // 降级：无转发能力时按文本逐段发送
    await this.reply([title, ...entries].join('\n'))
    return false
  }

  async getCommitId() {
    return (await this.exec('git rev-parse --short HEAD')).stdout
  }

  async getTime() {
    return (await this.exec('git log -1 --pretty=%cd --date=format:"%F %T"')).stdout
  }

  async getBranch() {
    return (await this.exec('git branch --show-current')).stdout
  }

  async getRemote(branch) {
    if (!branch) return ''
    return (await this.exec(`git config branch.${branch}.remote`)).stdout
  }

  gitErrUrl(error) {
    return error.match(/'(.+?)'/g)?.[0]?.replace(/'(.+?)'/, '$1') || ''
  }

  /**
   * 从 git 报错里提取「会被合并覆盖」的本地改动文件（最多 10 个，够用户判断）。
   * 形如：`error: Your local changes to the following files would be overwritten by merge:\n\tapp/a.js\n\tb.js\nPlease commit...`
   */
  overwriteFiles(stdout, error) {
    const text = `${stdout || ''}\n${error || ''}`
    // 已跟踪改动（Your local changes … would be overwritten）
    const m = text.match(/would be overwritten[^\n]*\n([\s\S]*?)(?:\n\s*(?:Please|Aborting|error:)|$)/)
    const tracked = m ? m[1].split('\n').map((s) => s.trim()).filter(Boolean) : []
    // 未跟踪文件冲突（Untracked working tree files would be overwritten / 会被覆盖）——
    // 2026-10-17 审计 high：这类文件 `git stash`（无 -u）救不了，必须单独提示。
    const u = text.match(/[Uu]ntracked working tree files[^\n]*\n([\s\S]*?)(?:\n\s*(?:Please|Aborting|error:)|$)/)
    const untracked = u ? u[1].split('\n').map((s) => s.trim()).filter(Boolean) : []
    return [...new Set([...untracked, ...tracked])].slice(0, 10)
  }

  /**
   * 未跟踪文件 ∩ 目标提交新增文件（2026-10-17 审计 high）。
   * 返回相对路径数组——这些文件会让 `git merge --ff-only` 直接 Aborting，
   * 且 `git stash push`（无 -u）救不了（未跟踪文件不进 stash）。
   */
  /**
   * git 对非 ASCII/含特殊字符的路径会输出带引号的 C 风格转义（`"\345\267\245/x.js"`）。
   * 两侧必须同法还原，否则非 ASCII 路径的未跟踪文件与上游新增文件「永不相等」→ 预检漏报、
   * 强更也不备份（第 10 轮审计 low：正是本函数想防的静默覆盖）。
   */
  unquoteGitPath(p) {
    const t = String(p || '').trim()
    if (!/^".*"$/.test(t)) return t
    // git 的 C 风格转义：`\345` 是**八进制字节**（UTF-8 的一个字节），不是 JSON 的 \uXXXX，
    // 所以只能用 Buffer 逐字节还原（JSON.parse 在这里会抛错/留反斜杠）。
    const inner = t.slice(1, -1)
    const bytes = []
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i]
      if (c === '\\' && /[0-7]/.test(inner[i + 1] || '')) { bytes.push(parseInt(inner.slice(i + 1, i + 4), 8)); i += 3 }
      else if (c === '\\' && inner[i + 1] === '\\') { bytes.push(92); i++ }
      else if (c === '\\' && inner[i + 1] === '"') { bytes.push(34); i++ }
      else for (const b of Buffer.from(c, 'utf8')) bytes.push(b)
    }
    return Buffer.from(bytes).toString('utf8')
  }

  async untrackedCollisions(target) {
    const untracked = (await this.exec('git -c core.quotePath=false ls-files --others --exclude-standard')).stdout || ''
    const added = (await this.exec(`git -c core.quotePath=false diff --name-only --diff-filter=A HEAD ${target}`)).stdout || ''
    const addSet = new Set(added.split('\n').map((s) => this.unquoteGitPath(s)).filter(Boolean))
    return untracked
      .split('\n')
      .map((s) => this.unquoteGitPath(s))
      .filter((f) => f && addSet.has(f))
  }

  /** 强更前把将被覆盖的未跟踪文件复制到 data/backup/untracked-<ts>/（审计建议：静默覆盖无备份） */
  async backupUntracked(files) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dir = path.join(PLUGIN_DIR, 'data', 'backup', `untracked-${stamp}`)
    let count = 0
    for (const rel of files) {
      try {
        const src = path.join(PLUGIN_DIR, rel)
        if (!fs.existsSync(src)) continue
        const dst = path.join(dir, rel)
        fs.mkdirSync(path.dirname(dst), { recursive: true })
        fs.copyFileSync(src, dst)
        count++
      } catch (e) {
        logger.warn?.(`[agents-plugin] 备份未跟踪文件失败：${rel}（${e?.message || e}）`)
      }
    }
    return { dir: count ? dir : null, count }
  }

  async gitErr(stdout, error) {
    const errStr = String(error || '')
    if (/unable to access|无法访问|Could not read from remote|Connection|timed out/.test(errStr)) {
      await this.reply(`远程仓库连接错误：${this.gitErrUrl(errStr)}`)
    } else if (/not found|未找到|does not (exist|appear)|不存在|Authentication failed|鉴权失败|repository/.test(errStr)) {
      await this.reply(`远程仓库地址/鉴权错误：${this.gitErrUrl(errStr)}`)
    } else if (/be overwritten by merge|被合并操作覆盖/.test(errStr)) {
      // 工作区有未提交改动、且这些文件正好被本次更新改动：git 会中止（不会丢数据）。
      // 必须显式警告 #agent强制更新 会 git reset --hard 丢改动，否则用户容易顺手强更导致代码丢失。
      const files = this.overwriteFiles(stdout, errStr)
      const list = files.length ? `\n会被覆盖的本地改动：\n${files.map((f) => `· ${f}`).join('\n')}` : ''
      await this.reply(
        `更新已中止：工作区有未提交改动/未跟踪文件，且这些文件本次更新也会改动。${list}\n`
        + '已中止，未改动任何文件。处理方式：\n'
        + '· 保留改动（推荐）：在插件目录执行 git stash push -u -m "本地改动"，再发送 #agent更新，之后 git stash pop\n'
        + '  （`-u` 会连未跟踪文件一起暂存；若上面列出的文件是未跟踪的本地文件，不加 `-u` 的 stash 救不了）\n'
        + '· 确认某些未跟踪文件可丢：先 git clean -n -- <路径> 预览，再 git clean -f -- <路径>\n'
        + '· 放弃改动：#agent强制更新（会执行 git reset --hard；未提交改动永久丢失，未跟踪同名文件会被覆盖，插件会先备份到 data/backup/）',
      )
    } else if (/Merge conflict|合并冲突/.test(stdout)) {
      await this.reply(`${errStr}\n${stdout}\n合并冲突：请在插件目录手动解决后重新 #agent更新`)
    } else if (/divergent branches|偏离的分支|not possible to fast-forward|fast-forward/.test(errStr)) {
      const ret = await this.exec('git pull --rebase')
      if (!ret.error && /Successfully rebased|成功变基/.test(ret.stdout + ret.stderr)) return true
      await this.reply(`${errStr}\n${stdout}\n若修改过文件请手动更新，否则发送 #agent强制更新`)
    } else {
      await this.reply(`${errStr}\n${stdout}\n未知错误，可尝试发送 #agent强制更新`)
    }
  }

  async updatePackage() {
    const cmd = 'pnpm install'
    if (process.platform === 'win32') return this.reply(`检测到依赖更新，请 #关机 后执行 ${cmd}`)
    await this.reply('检测到依赖更新，开始安装依赖')
    return this.exec(cmd)
  }

  restart() {
    import('../../other/restart.js').then(({ Restart }) => {
      new Restart(this.e).restart()
    }).catch((e) => logger.warn('[agents-plugin] 自动重启失败，请手动重启以应用更新', e?.message || e))
  }

  /** 本次更新（自 oldCommitId 起）的提交记录，逐条返回；未设 oldCommitId（#更新日志）则取最近提交。 */
  async getLogEntries() {
    const cm = await this.exec('git log -100 --pretty="%h||[%cd] %s" --date=format:"%F %T"')
    if (cm.error) return [cm.error.message]

    const logAll = cm.stdout.split('\n')
    if (!logAll.length) return []

    const log = []
    for (const str of logAll) {
      const parts = str.split('||')
      if (parts[0] === this.oldCommitId) break
      if (parts[1]?.includes('Merge branch')) continue
      if (parts[1]) log.push(parts[1])
    }
    return log
  }
}

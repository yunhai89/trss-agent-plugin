import path from 'node:path'
import { fileURLToPath } from 'node:url'
import plugin from '../../../lib/plugins/plugin.js'

let uping = false

/** 插件根目录（绝对路径）——不依赖进程 cwd，避免 pm2/外部启动 cwd 非 Yunzai 根时 git 在错误目录执行。 */
const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * agents-plugin 更新命令（参考 TRSS 标准更新模式，用 Bot.exec）。
 *   #agents更新 / #agents强制更新   拉取当前分支最新代码（强制=reset 到远端）；有改动时自动重启
 *   #agents版本                     最近一次提交时间
 *   #agents更新日志                 本次更新的提交记录
 * 仅主人可用。插件目录名 agents-plugin。
 */
export class AgentsUpdate extends plugin {
  constructor() {
    super({
      name: 'agents_更新',
      dsc: 'agents-plugin 更新',
      event: 'message',
      priority: 1000,
      rule: [
        { reg: '^#*(agents)(插件)?(强制)?更新$', fnc: 'update' },
        { reg: '^#?(agents)(插件)?版本$', fnc: 'pluginVersion' },
        { reg: '^#?(agents)(插件)?更新日志$', fnc: 'updateLog' },
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

  async gitErr(stdout, error) {
    const errStr = String(error || '')
    if (/unable to access|无法访问|Could not read from remote|Connection|timed out/.test(errStr)) {
      await this.reply(`远程仓库连接错误：${this.gitErrUrl(errStr)}`)
    } else if (/not found|未找到|does not (exist|appear)|不存在|Authentication failed|鉴权失败|repository/.test(errStr)) {
      await this.reply(`远程仓库地址/鉴权错误：${this.gitErrUrl(errStr)}`)
    } else if (/be overwritten by merge|被合并操作覆盖/.test(errStr) || /Merge conflict|合并冲突/.test(stdout)) {
      await this.reply(`${errStr}\n${stdout}\n若修改过文件请手动更新，否则发送 #agents强制更新`)
    } else if (/divergent branches|偏离的分支|not possible to fast-forward|fast-forward/.test(errStr)) {
      const ret = await this.exec('git pull --rebase')
      if (!ret.error && /Successfully rebased|成功变基/.test(ret.stdout + ret.stderr)) return true
      await this.reply(`${errStr}\n${stdout}\n若修改过文件请手动更新，否则发送 #agents强制更新`)
    } else {
      await this.reply(`${errStr}\n${stdout}\n未知错误，可尝试发送 #agents强制更新`)
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

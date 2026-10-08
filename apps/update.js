import plugin from '../../../lib/plugins/plugin.js'

let uping = false

/**
 * agents-plugin 更新命令（参考 TRSS 标准更新模式，用 Bot.exec）。
 *   #agents更新 / #agents强制更新   拉取最新代码（强制=reset 后 rebase）；有改动时自动重启
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

  exec(cmd, plugin, opts = {}) {
    if (plugin) opts.cwd = `plugins/${plugin}`
    return Bot.exec(cmd, opts)
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
      await this.runUpdate('agents-plugin')
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

  async runUpdate(plugin = 'agents-plugin') {
    let cm = 'git pull'
    let type = '更新'
    const force = this.e.msg.includes('强制')

    if (force) {
      type = '强制更新'
      // 先 fetch 再 reset 到远端分支：reset --hard 会覆盖「本地未跟踪但目标提交已跟踪」的文件，
      // 避免旧代码「reset 到过期 origin/xxx 后再 pull --rebase」被未跟踪文件挡住（#agents强制更新失败）。
      const remoteBranch = await this.getRemoteBranch(true, plugin)
      const branch = await this.getBranch(plugin)
      const target = remoteBranch || `origin/${branch || 'master'}`
      cm = `git fetch --all --prune && git reset --hard ${target}`
    }
    this.oldCommitId = await this.getCommitId(plugin)

    logger.mark(`[agents-plugin] 开始${type} ${plugin}`)
    if (!this.quiet) await this.reply(`开始${type} ${plugin}`)
    const ret = await this.exec(cm, plugin)

    if (ret.error && !(await this.gitErr(plugin, ret.stdout, ret.error.message))) {
      logger.mark(`[agents-plugin] 更新失败 ${plugin}`)
      return false
    }

    const time = await this.getTime(plugin)
    if (/Already up|已经是最新/.test(ret.stdout)) {
      if (!this.quiet) await this.reply(`${plugin} 已是最新\n最后更新时间：${time}`)
    } else {
      this.isUp = true
      if (/package\.json/.test(ret.stdout)) this.isPkgUp = true
      await this.reply(`${plugin} 更新成功\n更新时间：${time}`)
      await this.reply(await this.getLog(plugin))
    }

    logger.mark(`[agents-plugin] 最后更新时间：${time}`)
    return true
  }

  async pluginVersion() {
    if (!this.e.isMaster) return false
    const time = await this.getTime('agents-plugin')
    await this.reply(`agents-plugin 最后更新时间：${time}`)
    return true
  }

  async updateLog() {
    if (!this.e.isMaster) return false
    const log = await this.getLog('agents-plugin')
    await this.reply(log || '暂无更新日志')
    return true
  }

  async getCommitId(...args) {
    return (await this.exec('git rev-parse --short HEAD', ...args)).stdout
  }

  async getTime(...args) {
    return (await this.exec('git log -1 --pretty=%cd --date=format:"%F %T"', ...args)).stdout
  }

  async getBranch(...args) {
    return (await this.exec('git branch --show-current', ...args)).stdout
  }

  async getRemote(branch, ...args) {
    return (await this.exec(`git config branch.${branch}.remote`, ...args)).stdout
  }

  async getRemoteBranch(string, ...args) {
    const branch = await this.getBranch(...args)
    if (!branch && string) return ''
    const remote = await this.getRemote(branch, ...args)
    if (!remote && string) return ''
    return string ? `${remote}/${branch}` : { remote, branch }
  }

  gitErrUrl(error) {
    return error.match(/'(.+?)'/g)?.[0]?.replace(/'(.+?)'/, '$1') || ''
  }

  async gitErr(plugin, stdout, error) {
    if (/unable to access|无法访问/.test(error)) {
      await this.reply(`远程仓库连接错误：${this.gitErrUrl(error)}`)
    } else if (/not found|未找到|does not (exist|appear)|不存在|Authentication failed|鉴权失败/.test(error)) {
      await this.reply(`远程仓库地址错误：${this.gitErrUrl(error)}`)
    } else if (/be overwritten by merge|被合并操作覆盖/.test(error) || /Merge conflict|合并冲突/.test(stdout)) {
      await this.reply(`${error}\n${stdout}\n若修改过文件请手动更新，否则发送 #agents强制更新`)
    } else if (/divergent branches|偏离的分支/.test(error)) {
      const ret = await this.exec('git pull --rebase', plugin)
      if (!ret.error && /Successfully rebased|成功变基/.test(ret.stdout + ret.stderr)) return true
      await this.reply(`${error}\n${stdout}\n若修改过文件请手动更新，否则发送 #agents强制更新`)
    } else {
      await this.reply(`${error}\n${stdout}\n未知错误，可尝试发送 #agents强制更新`)
    }
  }

  async updatePackage() {
    const cmd = 'pnpm install'
    if (process.platform === 'win32') return this.reply(`检测到依赖更新，请 #关机 后执行 ${cmd}`)
    await this.reply('检测到依赖更新，开始安装依赖')
    return this.exec(cmd, { cwd: 'plugins/agents-plugin' })
  }

  restart() {
    import('../../other/restart.js').then(({ Restart }) => {
      new Restart(this.e).restart()
    }).catch((e) => logger.warn('[agents-plugin] 自动重启失败，请手动重启以应用更新', e?.message || e))
  }

  async getLog(plugin = 'agents-plugin') {
    const cm = await this.exec('git log -100 --pretty="%h||[%cd] %s" --date=format:"%F %T"', plugin)
    if (cm.error) return cm.error.message

    const logAll = cm.stdout.split('\n')
    if (!logAll.length) return ''

    const log = []
    for (let str of logAll) {
      const parts = str.split('||')
      if (parts[0] === this.oldCommitId) break
      if (parts[1]?.includes('Merge branch')) continue
      log.push(parts[1])
    }
    if (log.length <= 0) return ''

    return [`${plugin} 更新日志`, ...log].join('\n')
  }
}

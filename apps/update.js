import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import plugin from '../../../lib/plugins/plugin.js'

let uping = false

/** 插件根目录（绝对路径）——不依赖进程 cwd，避免 pm2/外部启动 cwd 非 Yunzai 根时 git 在错误目录执行。 */
const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 同步读取工作树的当前提交（短 sha）。用 fs 直接读 .git 而不调 git：
 * 该值必须在**模块加载时**（= 进程启动、代码被加载的那一刻）取到，异步 exec 会晚于代码加载。
 */
export function readGitHead(dir) {
  try {
    const gitDir = path.join(dir, '.git')
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim()
    if (!head.startsWith('ref:')) return head.slice(0, 7)
    const ref = head.slice(4).trim()
    try {
      return fs.readFileSync(path.join(gitDir, ref), 'utf8').trim().slice(0, 7)
    } catch {
      const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8')
      const line = packed.split('\n').find((l) => l.endsWith(` ${ref}`))
      return line ? line.split(' ')[0].slice(0, 7) : null
    }
  } catch {
    return null
  }
}

/** 同步读取 package.json 的 version（磁盘当前值）。 */
export function readPkgVersion(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version || null
  } catch {
    return null
  }
}

/**
 * 「磁盘代码是否比本进程加载的更新」——命中则必须重启才生效。
 * 场景：先手动 git pull / 上次自动重启失败 / 更新只改了配置——此时再发 #agents更新，
 * git 层面显示「已是最新」而不会重启，用户会以为已经生效（实机踩过：磁盘已 v1.26.8、进程仍跑 v1.25.2）。
 */
export function diskChangedSinceLoad({ diskHead, loadedHead, diskVersion, loadedVersion }) {
  if (diskHead && loadedHead && diskHead !== loadedHead) return 'head'
  if (diskVersion && loadedVersion && diskVersion !== loadedVersion) return 'version'
  return null
}

/** 本进程启动时代码所在提交与版本（模块加载时捕获一次） */
const LOADED_HEAD = readGitHead(PLUGIN_DIR)
const LOADED_VERSION = readPkgVersion(PLUGIN_DIR)

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
      // git 层面已是最新，但进程里跑的可能是旧代码（手动 pull / 上次重启失败 / 只改了配置）：
      // 不重启则磁盘上的新代码永远不会生效，必须主动重启并说明原因。
      const why = diskChangedSinceLoad({
        diskHead: after, loadedHead: LOADED_HEAD,
        diskVersion: readPkgVersion(PLUGIN_DIR), loadedVersion: LOADED_VERSION,
      })
      if (why) {
        this.isUp = true // 交给 update() 触发 restart()
        await this.reply(`agents-plugin 磁盘代码已是最新（${after} @ v${readPkgVersion(PLUGIN_DIR) ?? '?'}），但当前进程加载的是 ${LOADED_HEAD || '未知提交'}${LOADED_VERSION ? ` @ v${LOADED_VERSION}` : ''}\n正在重启以加载磁盘上的新代码…`)
        logger.mark(`[agents-plugin] 磁盘 ${after} ≠ 进程加载 ${LOADED_HEAD}（${why}），重启以生效`)
        return true
      }
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

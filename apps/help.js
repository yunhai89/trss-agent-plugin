import plugin from '../../../lib/plugins/plugin.js'
import Config from '../utils/Config.js'
import { buildHelpHtml } from '../model/agent/index.js'
import { screenshot } from './render.js'

const SECTIONS = [
  {
    title: '触发对话',
    commands: [
      { cmd: '@机器人 +内容', desc: '艾特机器人对话（默认触发）' },
      { cmd: '#ai +内容', desc: '自定义触发词（需 agent.trigger=command/both）' },
    ],
  },
  {
    title: '对话管理',
    commands: [
      { cmd: '#聊天列表', desc: '查看你的所有对话（图片）' },
      { cmd: '#进入聊天 +id', desc: '切换到指定对话继续聊天' },
      { cmd: '#new', desc: '新建一段对话' },
    ],
  },
  {
    title: '记忆 / 提醒',
    commands: [
      { cmd: '#记忆', desc: '查看长期记忆' },
      { cmd: '#忘掉 +关键词', desc: '按关键词遗忘记忆' },
      { cmd: '#我的提醒', desc: '查看我的提醒' },
      { cmd: '#取消提醒 +id', desc: '取消指定提醒' },
      { cmd: '#清空所有记录', desc: '清空自己的对话/记忆/提醒等（不含配置，2步确认）' },
    ],
  },
  {
    title: '知识库',
    commands: [
      { cmd: '#知识库添加 +文本/URL', desc: '主人：文档/网页入库（URL 自动抓取正文）' },
      { cmd: '#知识库列表', desc: '查看知识库文档（🌐=网页URL）' },
      { cmd: '#知识库刷新 +id', desc: '主人：刷新某网页文档（拉取最新内容）' },
      { cmd: '#知识库定时 +id +时间', desc: '主人：定时刷新网页文档（每天8点/每2小时…）' },
      { cmd: '#知识库删除 +id', desc: '主人：删除文档' },
      { cmd: '#知识库重建', desc: '主人：重建向量索引（换 embedding 模型后）' },
    ],
  },
  {
    title: '定时任务',
    commands: [
      { cmd: '#定时任务 +时间 +任务', desc: '主人：cron 重复任务链（到点跑任务+发结果）。时间：每天8点/每2小时/工作日9点/每周一8点30' },
      { cmd: '#定时任务列表', desc: '查看所有定时任务' },
      { cmd: '#取消定时任务 +id', desc: '主人：取消定时任务' },
    ],
  },
  {
    title: '人设',
    commands: [
      { cmd: '#人设', desc: '查看人设列表（图片）' },
      { cmd: '#人设 +id', desc: '切换到指定人设' },
      { cmd: '#人设详情 +id', desc: '查看人设内容' },
      { cmd: '#新建人设 +名称 +内容', desc: '创建自定义人设并切换' },
      { cmd: '#删除人设 +id', desc: '删除自定义人设' },
      { cmd: '#重置人设', desc: '恢复默认人设' },
    ],
  },
  {
    title: '深度研究',
    commands: [
      { cmd: '#研究 +主题', desc: '深度研究（结果优先 PDF→高清图→文本）' },
    ],
  },
  {
    title: '表情包',
    commands: [
      { cmd: '#表情包安装', desc: '克隆表情包仓库（自动测速选最快 GitHub 代理）' },
      { cmd: '#表情包更新', desc: '拉取上游更新（HEAD 未变则跳过）' },
      { cmd: '#表情包状态', desc: '总数/体积/上游 commit/高频 Top5' },
      { cmd: '#表情包开启 / #表情包关闭', desc: '热开关（即改即生效）' },
      { cmd: '#表情包目录', desc: '查看源目录；#表情包目录 启用/停用 <名> 管理子集' },
    ],
  },
  {
    title: '主人指令',
    commands: [
      { cmd: '#模型切换 +id', desc: '切换 LLM 模型' },
      { cmd: '#添加mcp +JSON', desc: '添加 MCP；私聊可不带 JSON，进入交互式添加（粘 JSON 即用）' },
      { cmd: '#启用mcp +名', desc: '启用某个 MCP 服务端' },
      { cmd: '#停止mcp +名', desc: '停止某个 MCP 服务端' },
      { cmd: '#mcp', desc: '查看 MCP 连接状态' },
      { cmd: '#agents更新', desc: '更新插件（有改动自动重启）' },
      { cmd: '#agents版本', desc: '查看当前插件版本号' },
      { cmd: '#agents更新日志', desc: '查看近期版本更新日志' },
      { cmd: '#agents重载', desc: '热重载配置（免重启）' },
      { cmd: '#agents状态', desc: '查看插件运行状态（触发模式/模型/调试日志）' },
      { cmd: '#agents登录', desc: '获取 Web 管理面板地址（带 token，24h 有效；主人私聊发送）' },
      { cmd: '#确认 / #拒绝 +id', desc: '审批待执行的危险动作' },
      { cmd: '#待确认', desc: '列出待审批' },
      { cmd: '#上报错误 +描述', desc: '上报问题给 master（所有人可发，附最近会话日志）' },
      { cmd: '#openrouter余额', desc: '查询 OpenRouter key 额度/用量（需 preset=openrouter）' },
    ],
  },
  {
    title: '在线自进化（主人）',
    commands: [
      { cmd: '#LLM进化', desc: '手动触发一次自进化评审（不等 N 轮自动，产出 suggestion）' },
      { cmd: '#审阅进化', desc: '查看后台自评审产出的待审 suggestion（prompt/技能类）' },
      { cmd: '#采纳 +id', desc: '采纳一条 suggestion（prompt 类下轮生效）' },
      { cmd: '#拒绝进化 +id', desc: '拒绝并删除一条 suggestion' },
      { cmd: '#回滚 +key', desc: '回滚 prompt 到内置默认（如 #回滚 agent）' },
      { cmd: '#进化 prompt +key', desc: '离线 GEPA 进化 prompt（采样轨迹→迭代→judge，约 1-3 分钟）' },
      { cmd: '#进化工具 +能力描述', desc: '生成候选工具（LLM 生成 + typescript AST 验证 → draft，待审批上线）' },
      { cmd: '#工具进化列表', desc: '查看所有进化工具版本与状态（draft/verified/stable/rejected）' },
      { cmd: '#采纳工具 +versionId', desc: '采纳 verified 候选 → stable 并注入（agent 可调用）' },
      { cmd: '#淘汰工具 +versionId', desc: '淘汰工具（仅影响目标版本；active 淘汰时自动回滚或下线）' },
      { cmd: '#回滚工具 +工具名 +semver', desc: '回滚工具到指定 stable 版本（切 active + 重新注入）' },
      { cmd: '#工具健康', desc: '工具库收敛指标 + 高失败率工具检测（触发修复）' },
    ],
  },
  {
    title: '群聊小世界',
    commands: [
      { cmd: '#查看我的群聊画像', desc: '查看本群对你的人物画像（标注来源/置信，仅自己可见）' },
      { cmd: '#纠正我的群聊画像 +内容', desc: '补充/纠正画像（按高可信信息记录）' },
      { cmd: '#删除我的群聊画像', desc: '删除你的画像与关系等派生数据' },
      { cmd: '#关闭我的群聊建模', desc: '停止对你在此群的建模（同时清除已有数据）' },
      { cmd: '#开启我的群聊建模', desc: '恢复对你在此群的建模' },
      { cmd: '#群世界状态', desc: '查看 GroupWorld 数据规模与任务状态（主人）' },
      { cmd: '#群世界清理 +群号', desc: '清理指定群全部 GroupWorld 数据（主人）' },
    ],
  },
]

export class Help extends plugin {
  constructor() {
    super({
      name: 'agents帮助',
      dsc: '查看 agents-plugin 帮助（图片）',
      event: 'message',
      priority: 500,
      rule: [
        { reg: '^#agents帮助$', fnc: 'help' },
        { reg: '^#agents状态$', fnc: 'status', permission: 'master' },
      ],
    })
  }

  async help() {
    const html = buildHelpHtml({ title: 'agents-plugin 帮助', subtitle: 'AI Agent · 工具 · 记忆 · MCP', sections: SECTIONS })
    const img = await screenshot('agents-plugin/help', html)
    if (img) return this.e.reply(img), true
    // 文本回退（puppeteer 不可用时）
    const lines = ['#agents帮助']
    for (const s of SECTIONS) {
      lines.push(`【${s.title}】`)
      for (const c of s.commands) lines.push(`${c.cmd}  ${c.desc}`)
    }
    await this.e.reply(lines.join('\n'))
    return true
  }

  async status() {
    const a = (Config.get() || {}).agent || {}
    const debug = (Config.get() || {}).debug
    await this.e.reply([
      'agents-plugin 状态',
      `触发模式：${a.trigger || 'at'}（${a.triggerCommand || '#ai'}）`,
      `当前模型：${a.model || '未配置'}`,
      `调试日志：${debug ? '开' : '关'}`,
    ].join('\n'))
    return true
  }
}

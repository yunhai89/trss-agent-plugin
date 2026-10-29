/**
 * QQ 官方机器人（QQBot）专属工具：发送「Markdown 卡片 + inline keyboard 按钮」。
 *
 * 为什么是工具 + 应用层投递（而不是工具里直接 e.reply）：
 *  - 与 diagram_render 同一约定：工具只产出「待投递内容」，由 apps/agent.js 在最终回复之后
 *    经受控发送队列发出，保证「进度 → 正文 → 卡片」的顺序，且发送失败不污染对话终态；
 *  - 卡片本身仍要能在中途发送才有交互价值，故 apps 会在**最终正文送达后**立刻 flush。
 *
 * 安全：回调按钮（callback）点击后会把按钮文本当作用户消息发回，等价于「替用户发一句话」。
 * 因此默认只允许**触发者本人**点击（adapter 的 action.permission.specify_user_ids），
 * 需要所有人可点时显式传 public: true。回调文本本身仍会走插件权限校验。
 */

import { detectAdapter, buildMarkdownMessage, normalizeKeyboard, MARKDOWN_MAX_CHARS } from './index.js'

/** 卡片的硬上限（防单轮刷屏） */
export const MAX_CARDS_PER_RUN = 3

/** 从 LLM 入参归一卡片定义；非法返回 { error } */
export function normalizeCardSpec(params = {}) {
  const text = String(params.text ?? params.markdown ?? params.content ?? '').trim()
  const keyboardRaw = params.keyboard ?? params.buttons ?? null
  const keyboard = normalizeKeyboard(keyboardRaw)
  const templateId = String(params.templateId ?? params.template_id ?? '').trim()
  if (!text && !templateId) return { error: '缺少 text（markdown 正文）或 templateId' }
  if (!keyboard.length) return { error: '缺少可用按钮（keyboard/buttons 至少 1 个带 action 的按钮）' }
  if (text.length > MARKDOWN_MAX_CHARS * 2) return { error: `正文过长（>${MARKDOWN_MAX_CHARS * 2} 字），请精简后重试` }
  return {
    card: {
      // 模板模式：官方模板 ID + 参数（params 为 [{key, values:[...]}]）
      ...(templateId ? { markdown: { templateId, params: params.params || params.templateParams || [] } } : { markdown: text }),
      keyboard,
      public: params.public === true,
    },
  }
}

/**
 * 生成 send_keyboard 工具。
 * 说明：是否真的能发（官方适配器 / 当前会话）在执行期判断（ctx.e 按事件而定，多账号部署时
 * 同一运行时可能同时服务 OneBot 与官方机器人）。
 * @param {object} [opts]
 * @param {function} [opts.logger] 日志函数（(level, ...args)）
 */
export function makeSendKeyboardTool({ logger = () => {} } = {}) {
  return {
    name: 'send_keyboard',
    description: '给用户发一张带按钮的交互卡片（仅 QQ 官方机器人支持；其他协议会提示不可用）。'
      + '正文用 Markdown（支持标题/列表/表格/代码块/链接），按钮最多 5 行、每行最多 5 个。'
      + '按钮类型三选一：callback（点击后把一段文本作为用户消息发回，一般写插件命令，如「#确认 12」）、'
      + 'link（打开网址）、input（把文本填进输入框）。'
      + '回调按钮默认只有当前用户能点（public:true 才放开所有人）。'
      + '适合：需要用户点选下一步、确认高危操作、给多个入口时。普通回复不要用它。',
    // 类别选 personal：动作只是「给当前会话回一条更丰富的消息」，与普通回复同级，
    // 不额外扩大触达面（message 类别要求管理员以上，普通成员根本拿不到按钮卡片，属过度限制）。
    category: 'personal',
    meta: { summary: '发送按钮卡片', sideEffects: ['message'], resultCap: 800 },
    parameters: {
      type: 'object',
      required: ['text', 'keyboard'],
      properties: {
        text: { type: 'string', description: `Markdown 正文（≤${MARKDOWN_MAX_CHARS} 字）`, maxLength: MARKDOWN_MAX_CHARS },
        keyboard: {
          type: 'array',
          description: '按钮行数组：[[{text,callback}|{text,link}|{text,input,text?}], ...]，最多 5 行 × 5 个',
          items: {
            type: 'array',
            items: {
              type: 'object',
              required: ['text'],
              properties: {
                text: { type: 'string', description: '按钮文案' },
                callback: { type: 'string', description: '点击后发回的文本（当作该用户发言）' },
                link: { type: 'string', description: '打开的链接 URL' },
                input: { type: 'string', description: '填入输入框的文本' },
                send: { type: 'boolean', description: 'input 类型是否直接发送（默认 true）' },
                clicked_text: { type: 'string', description: '点击后按钮上显示的文案（可选）' },
                public: { type: 'boolean', description: 'true=所有人可点（默认仅触发者）' },
              },
            },
          },
        },
        public: { type: 'boolean', description: '所有按钮放开给所有人（默认仅触发者，谨慎）' },
        templateId: { type: 'string', description: '官方 Markdown 模板 ID（需后台申请；给了就忽略 text 正文，改用模板）' },
        params: { type: 'array', description: '模板参数 [{key, values:[...]}]（仅 templateId 模式）' },
      },
      additionalProperties: false,
    },
    async execute(args = {}, ctx = {}) {
      const e = ctx?.e
      if (!e) return { error: '当前上下文缺少事件对象，无法发送卡片' }
      const adapter = detectAdapter(e)
      if (!adapter.official) {
        return {
          error: 'unsupported_protocol',
          reason: '按钮卡片仅 QQ 官方机器人适配器支持（当前是 OneBot/ICQQ 等协议）',
          hint: '普通回复即可；如需在官方机器人上使用，请把协议端切换到 QQ 官方机器人（Yunzai-QQBot-Plugin）。',
        }
      }
      const { card, error } = normalizeCardSpec(args)
      if (error) return { error, hint: '按「text + keyboard」两个参数重试' }
      const pending = Array.isArray(ctx.pendingCards) ? ctx.pendingCards : (ctx.pendingCards = [])
      if (pending.length >= MAX_CARDS_PER_RUN) {
        return { error: 'card_limit', reason: `单轮最多 ${MAX_CARDS_PER_RUN} 张卡片` }
      }
      // 校验能力：markdown 段缺失（Miao 等非 TRSS 框架）时不排队，直接告知
      const probe = buildMarkdownMessage(e, { markdown: 'x' }, { keyboard: [[{ text: 'x', callback: 'x' }]], ownerId: '' })
      if (!probe) {
        return { error: 'unsupported_framework', reason: '当前框架的 segment 不支持 markdown/button（需 TRSS-Yunzai）' }
      }
      pending.push(card)
      logger('debug', '[qqofficial] 卡片已排队', `本轮第 ${pending.length} 张`, `上下文=${adapter.kind}`)
      return {
        ok: true,
        queued: pending.length,
        hint: '卡片将在本轮最终回复之后自动发送；不要在正文里重复描述按钮内容。',
      }
    },
  }
}

/**
 * 投递本轮排队的卡片（由 apps/agent.js 在最终回复后调用）。
 * @param {object} params
 * @param {object} params.ctx 工具上下文（读取 pendingCards）
 * @param {function} params.send 受控发送函数（(msg, quote) => Promise<{ok,ret,error}>）
 * @param {function} [params.logger]
 * @returns {Promise<{sent:number, failed:number}>}
 */
export async function flushPendingCards({ ctx, send, logger = () => {} }) {
  const e = ctx?.e
  const cards = Array.isArray(ctx?.pendingCards) ? ctx.pendingCards : []
  if (!e || !cards.length) return { sent: 0, failed: 0 }
  const adapter = detectAdapter(e)
  if (!adapter.official) {
    logger('warn', '[qqofficial] 丢弃排队卡片：当前协议不支持按钮卡片')
    ctx.pendingCards = []
    return { sent: 0, failed: cards.length }
  }
  let sent = 0
  let failed = 0
  for (const card of cards) {
    try {
      const msg = buildMarkdownMessage(e, card.markdown, {
        keyboard: card.keyboard,
        ownerId: e.user_id,
        allowPublic: card.public === true,
      })
      if (!msg) { failed++; continue }
      const r = await send(msg, false)
      if (r && r.ok !== false) sent++
      else { failed++; logger('warn', '[qqofficial] 卡片发送失败', r?.error || 'unknown') }
    } catch (err) {
      failed++
      logger('warn', '[qqofficial] 卡片发送异常', err?.message || err)
    }
  }
  ctx.pendingCards = []
  logger('debug', '[qqofficial] 卡片投递完成', `成功 ${sent} / 失败 ${failed}`)
  return { sent, failed }
}

export default { makeSendKeyboardTool, flushPendingCards, normalizeCardSpec, MAX_CARDS_PER_RUN }

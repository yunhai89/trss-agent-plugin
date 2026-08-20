/**
 * diagram_render 工具 —— 主 Agent 的示意图生成入口。
 *
 * 使用策略（写入工具描述，模型按此路由）：
 *   优先：用户明确要求画图/流程图/架构图/时序图；≥3 个重要节点；有分支/循环/并行/状态转移；
 *         一个组件影响 ≥3 个下游；纯文字需要长篇才能说清。
 *   不用：单一事实、两步以内的简单关系、闲聊、纯数字统计图、照片/插画/人物、用户要求纯文字。
 *
 * LLM 只提交语义 DiagramSpec；endpoint/引擎/字体/尺寸/路径均不可由参数控制。
 * 成功结果由应用层（apps/agent.js）识别 type:'diagram' 后随最终回复经 segment.image 发送——
 * 工具本身绝不直接 e.reply，杜绝重复发送/迟到图片。
 */
import { defineTool } from '../toolkit/define.js'
import { NODE_KINDS, EDGE_KINDS, DIAGRAM_TYPES } from './spec.js'
import { THEME_NAMES } from './themes.js'

const strArr = (item, description) => ({ type: 'array', items: item, description })
const str = (description) => ({ type: 'string', description })
const enumStr = (description, values) => ({ type: 'string', enum: values, description })

export const DIAGRAM_TOOL_DESCRIPTION = `根据结构化节点、连接、分组或时序消息生成精确示意图，并返回可发送的图片。
适用于流程图、架构图、时序图、状态图、关系图和思维导图。
何时使用：① 用户要求画图/流程图/架构图/时序图等；② 你在向用户解释流程、架构、状态流转、多方协作或组件关系时，
如果预计纯文字描述冗长或结构复杂（≥3 个关键部分、有分支/循环/并行/层级），可以主动调用本工具生成配图让表达更直观——无需用户明确要求。
不要用于照片、人物、风景、艺术插画，也不要用于只有两个简单步骤、纯数据统计图、闲聊或一两句话能说清的问题。
只提供语义关系，不要计算坐标，不要生成 SVG/HTML/CSS。
信息不足以确定系统组件时，先向用户确认或只画已确认的部分，不要编造组件。
成功后图片会随回复自动发送给用户：回复正文简要说明图形内容即可，不要输出文件路径，不要重复描述每条连线。`

/** @param {import('./index.js').DiagramService} service */
export function makeDiagramTool(service) {
  return defineTool({
    name: 'diagram_render',
    description: DIAGRAM_TOOL_DESCRIPTION,
    category: 'query',
    meta: {
      summary: '生成流程图/架构图/时序图/状态图/关系图/思维导图并作为图片发送',
      resultCap: 4000,
      interactive: false,
      sideEffects: ['file_write'], // 仅写插件 data/diagram/ 临时目录
    },
    parameters: {
      type: 'object',
      properties: {
        type: enumStr('图类型', DIAGRAM_TYPES),
        title: str('图标题（1~100 字，会显示在图上方）'),
        theme: enumStr('视觉主题（默认 paper-blue）', THEME_NAMES),
        direction: enumStr('布局方向（默认按图类型自动）', ['top-down', 'left-right']),
        output: enumStr('输出格式（默认 png）', ['png', 'svg']),
        caption: str('图下方说明文字（可选，≤200 字）'),
        nodes: strArr(
          {
            type: 'object',
            properties: {
              id: str('节点标识（唯一，勿含引号/斜杠/路径）'),
              label: str('节点显示文字（≤80 字）'),
              kind: enumStr('节点形态', NODE_KINDS),
              group: str('所属分组 id（可选）'),
              description: str('备注（可选，≤200 字）'),
            },
            required: ['id', 'label'],
          },
          '节点列表（除 sequence 外的图类型必填）',
        ),
        edges: strArr(
          {
            type: 'object',
            properties: {
              from: str('起点节点 id'),
              to: str('终点节点 id'),
              label: str('连线文字（可选）'),
              kind: enumStr('连线类型', EDGE_KINDS),
            },
            required: ['from', 'to'],
          },
          '连线列表（from/to 必须是已声明的节点 id）',
        ),
        groups: strArr(
          {
            type: 'object',
            properties: { id: str('分组标识'), label: str('分组显示名'), parent: str('父分组 id（可嵌套，禁止循环）') },
            required: ['id', 'label'],
          },
          '分组/容器列表（架构图常用）',
        ),
        participants: strArr(
          {
            type: 'object',
            properties: { id: str('参与者标识'), label: str('参与者显示名'), kind: enumStr('参与者类型', ['actor', 'service', 'database']) },
            required: ['id', 'label'],
          },
          '时序图参与者（仅 sequence，至少 2 个）',
        ),
        messages: strArr(
          {
            type: 'object',
            properties: {
              from: str('发送方参与者 id'), to: str('接收方参与者 id'),
              label: str('消息内容'), kind: enumStr('消息类型', ['sync', 'async', 'return']),
              order: { type: 'number', description: '顺序号（可选，缺省按声明顺序）' },
            },
            required: ['from', 'to', 'label'],
          },
          '时序图消息（按 order 升序渲染；仅 sequence）',
        ),
      },
      required: ['type', 'title'],
    },
    async execute(params, ctx) {
      if (!service) return { ok: false, errorClass: 'renderer_unavailable', message: 'diagram 服务未初始化' }
      const r = await service.render(params, {
        signal: ctx?.signal || null,
        toolCallId: ctx?.taskId || '',
        traceId: ctx?.devScope?.convId || '',
      })
      if (!r.ok) return r // 结构化失败（errorClass/message/field/retryable）→ Agent 归一为 {error} 并附 _hint
      // 给模型的回执：图片已生成、将由应用层自动发送；提醒不要把路径复述给用户
      return { ...r, note: '图片将随本次回复自动发送；回复中不要输出文件路径或 DSL 内容' }
    },
  })
}

/**
 * 任务续跑（F06）—— 依据 TaskStore 检查点重建可续跑的对话，让同一任务在恢复后继续。
 *
 * 与 recovery.js 的分工：
 *   - recovery.js：推导「崩溃后每个步骤该 reuse/retry/reconcile/block」的**计划**（副作用安全）；
 *   - 本模块：把「已提交的结果」重建为合法的 assistant(tool_calls)+tool 配对消息，供 Agent 续跑，
 *     并把未完成/失败步骤作为指引交由模型继续，避免重复已完成的副作用。
 */

/** 按检查点推导续跑可行性：存在未知写副作用（block/reconcile）时不自动续跑。 */
export function classifySteps(checkpoint) {
  const steps = checkpoint?.steps || []
  const completed = steps.filter((s) => s.ok === true)
  const failed = steps.filter((s) => s.ok === false)
  const pending = steps.filter((s) => s.ok === null)
  return { completed, failed, pending }
}

/**
 * 重建续跑消息：已完成且保留只读结果正文的步骤重建为 tool_call/tool_result 配对；
 * 已完成但未保留正文的步骤以文字说明保留（避免重复执行）；最后追加续跑指引。
 * @param {object} checkpoint TaskStore.getCheckpoint 结果
 * @returns {Array} 可 setHistory 的消息数组
 */
export function buildResumeMessages(checkpoint, { continuationPrompt = '请基于以上已完成的步骤，继续完成原任务并给出最终结果。不要重复执行已完成的步骤。' } = {}) {
  const messages = []
  if (checkpoint?.input) messages.push({ role: 'user', content: String(checkpoint.input) })
  const { completed, failed, pending } = classifySteps(checkpoint)
  const noteLines = []
  let idx = 0
  for (const s of completed) {
    const hasArgs = s.args !== undefined && s.args !== null
    if (hasArgs && s.resultPreview != null) {
      const callId = `resume_${s.callId}_${idx++}`
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [{ id: callId, type: 'function', function: { name: s.name, arguments: JSON.stringify(s.args) } }],
      })
      messages.push({ role: 'tool', tool_call_id: callId, name: s.name, content: String(s.resultPreview) })
    } else {
      noteLines.push(`- 已完成：${s.name || s.callId}（未保留正文，勿重复执行）`)
    }
  }
  const guidance = [
    '【恢复续跑】以下为此前任务已提交的步骤结果（tool 消息）。请据此继续完成原任务。',
    noteLines.length ? `已完成但未保留正文的步骤：\n${noteLines.join('\n')}` : '',
    failed.length ? `此前失败的步骤：${failed.map((s) => s.name || s.callId).join('、')}（可重试或换方法）` : '',
    pending.length ? `未开始/未完成的步骤：${pending.map((s) => s.name || s.callId).join('、')}` : '',
    continuationPrompt,
  ].filter(Boolean).join('\n\n')
  messages.push({ role: 'user', content: guidance })
  return messages
}

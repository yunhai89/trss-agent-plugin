// node-schedule 桩 —— E2E harness 用（可选依赖，dev/CI 环境未安装；真实库会在装配期注册真实 cron）。
// 只实现 apps 层用到的最小面：scheduleJob / cancelJob / RecurrenceRule。
const jobs = []
export function scheduleJob(...args) {
  const fn = args.find((a) => typeof a === 'function')
  const job = {
    name: String(args[0] || ''),
    cancel: () => { const i = jobs.indexOf(job); if (i >= 0) jobs.splice(i, 1); return true },
  }
  if (fn) jobs.push({ job, fn })
  return job
}
export function cancelJob(job) {
  if (job?.cancel) return job.cancel()
  return false
}
export class RecurrenceRule {
  constructor() { this.second = null; this.minute = null; this.hour = null; this.dayOfWeek = null }
}
export const __jobs = jobs
export default { scheduleJob, cancelJob, RecurrenceRule }

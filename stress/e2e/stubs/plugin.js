// Yunzai lib/plugins/plugin.js 桩——E2E harness 用（真实 base 会 import #miao/读 redis，离线不可用）。
export default class plugin {
  constructor(opts = {}) {
    this.name = opts.name
    this.dsc = opts.dsc
    this.event = opts.event
    this.priority = opts.priority
    this.rule = opts.rule
    this.task = opts.task
    this.handler = opts.handler
  }
}

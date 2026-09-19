/**
 * 判断一个导出值是否为 class。
 *
 * 背景：Yunzai 插件加载器对 `module.apps` 里每个「带 prototype」的导出都执行
 * `new p()` 再读 `init.task`（lib/plugins/loader.js:150-160、530-538）。普通函数声明
 * 同样有 prototype，会被误当插件类：new 出的实例没有 task → collectTask(undefined)
 * 访问 undefined.cron 抛 "Cannot read properties of undefined (reading 'cron')"。
 * 因此导出给 Yunzai 前必须只保留 class（箭头函数/函数声明/变量都不行）。
 */
export function isPluginClass(v) {
  return typeof v === 'function' && /^\s*class[\s{]/.test(Function.prototype.toString.call(v))
}

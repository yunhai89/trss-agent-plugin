// utils/Config.js 桩——E2E harness 用（真实 Config 读写源码仓 config/*.yaml，测试需内存配置 + 临时目录）。
// __setConfig 由驱动脚本在 import apps 之前调用（hooks 已把本模块替换为所有 import 方的 Config）。
export const __state = { config: { agent: {} } }
export function __setConfig(c) { __state.config = c }

const TMP = process.env.E2E_TMP || '/tmp/e2e-harness'
const P = (...seg) => [TMP, ...seg].join('/')
export default {
  get: () => __state.config,
  save: () => { throw new Error('E2E 桩不支持 Config.save') },
  onChange: () => () => {},
  reload: () => false,
  startWatch: () => {},
  // path 契约与真实 Config 对齐（缺字段会让 import 期 path.join(undefined) 直接抛，如 model/sticker）
  path: {
    plugin: TMP, yunzai: TMP, defaultConfig: P('default_config'), userConfig: P('config.yaml'), legacyUserConfig: P('agents-plugin.yaml'),
    data: TMP, temp: P('temp'), logs: P('logs'), humanizeLogs: P('humanize-logs'), memories: P('memories'), personas: P('personas'), evolution: P('evolution'),
  },
}

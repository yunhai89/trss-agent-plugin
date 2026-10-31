/**
 * ────────────────────────────────────────────────────────────────────────────
 *  agents-plugin · 自定义工具包开发模板（参考用，可直接改）
 * ────────────────────────────────────────────────────────────────────────────
 * 把本文件放进插件根的 tools/ 目录即被自动加载（TRSS-Yunzai apps 风格）。
 * 删除本文件或重命名后缀即取消加载。
 *
 * 三种合法导出形态（任选其一）：
 *
 * 1) 工具包（推荐）：default export defineToolPack({...})
 *    - name 作为命名空间，自动给每个子工具加 `${name}__` 前缀，避免重名
 *    - tools: [...] 静态工具，或 factory(ctx) => [...] 动态生成
 *
 * 2) 工具数组：export default [ defineTool({...}), ... ]
 *    - 匿名包，按文件名做命名空间
 *
 * 3) 工厂函数：export default function(ctx){ return [...] }
 *
 * 工具契约：{ name, description, parameters, execute(params, ctx), category?, meta? }
 *   - category 决定 RBAC：query(0) | personal(0) | message(1) | group_manage(2) | system(3)
 *   - meta.interactive=true 会强制串行；meta.alwaysConfirm=true 才会每次走 confirm 审批（危险动作用）
 *   - ctx 含：userId/groupId/role/isMaster/e(Yunzai事件)/bot(Bot句柄)/fetcher/media/miyoushe...
 *
 * 辅助（from '../model/toolkit/index.js'）：
 *   defineTool / defineToolPack / param(str|num|int|bool|enum|object) / ok / fail / markdown
 *   getBot / getGroup / getFriend / getMember（优雅降级，缺失返回 null）
 * ────────────────────────────────────────────────────────────────────────────
 */
import {
  defineToolPack,
  defineTool,
  param,
  ok,
  getGroup,
} from '../model/toolkit/index.js'

// 一个最简单的示例工具：返回当前群名（演示 getGroup + ctx 访问）
const groupGreetTool = defineTool({
  name: 'group_greet',
  description: '示例：返回当前群的群名。开发完成后请改成你自己的工具，或删除整个 example.js。',
  category: 'query',
  parameters: param.object({}),
  async execute(_p, ctx) {
    const g = getGroup(ctx)
    if (!g) return ok('当前不是群聊会话')
    try {
      const info = typeof g.getInfo === 'function' ? await g.getInfo() : {}
      return ok(`当前群：${info.group_name || info.name || ctx.groupId || '未知'}`)
    } catch (e) {
      return ok(`获取群名失败：${e?.message || e}`)
    }
  },
})

export default defineToolPack({
  name: 'example',
  description: 'agents-plugin 自定义工具包示例模板',
  author: 'your-name',
  version: '1.0.0',
  tools: [groupGreetTool],
})

/* ── 工厂示例（按 ctx 动态生成工具）──
export default defineToolPack({
  name: 'myfactory',
  factory: (ctx) => [
    defineTool({
      name: 'whoami',
      description: '返回调用者 QQ',
      category: 'query',
      parameters: param.object({}),
      execute: async (_p, c) => ok(`你的 QQ：${c.userId}`),
    }),
  ],
})
*/

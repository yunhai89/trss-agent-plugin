/**
 * 工具开发 SDK 公共出口。
 *
 * 开发者写一个自定义工具包，放到插件根的 tools/ 目录即可被自动加载（Yunzai 风格）：
 *
 *   // tools/my-pack.js
 *   import { defineToolPack, defineTool, param, getGroup } from '../model/toolkit/index.js'
 *   export default defineToolPack({
 *     name: 'my',
 *     description: '我的工具包',
 *     author: 'someone',
 *     tools: [
 *       defineTool({
 *         name: 'echo_group',
 *         description: '返回当前群名',
 *         category: 'query',
 *         parameters: param.object({}),
 *         async execute(p, ctx) {
 *           const g = getGroup(ctx)
 *           return g ? `当前群：${(await g.getInfo?.())?.group_name || '?'}` : '非群聊'
 *         },
 *       }),
 *     ],
 *   })
 */

import {
  defineTool, defineToolPack, getBot, getEvent, getGroup, getFriend, getMember,
  sendApi, groupIdOf, botGroupRole, param, ok, fail, markdown, roleRank, VALID_CATEGORIES,
} from './define.js'
import { loadToolPacks, asPack } from './loader.js'

export {
  defineTool, defineToolPack,
  getBot, getEvent, getGroup, getFriend, getMember,
  sendApi, groupIdOf, botGroupRole, param, ok, fail, markdown, roleRank, VALID_CATEGORIES,
  loadToolPacks, asPack,
}
export { sendImage, sendVoice, sendVideo, sendFile, sendText } from './media.js'

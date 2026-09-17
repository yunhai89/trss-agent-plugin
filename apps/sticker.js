import plugin from '../../../lib/plugins/plugin.js'
import { getStickerManager } from '../model/sticker/manager.js'

/**
 * 表情包管理指令（仅主人）。
 *   #表情包状态        总数/体积/高频 Top5
 *   #表情包开启 / #表情包关闭   热开关
 *
 * 资源来源：仅**自动发现**（群内图片经视觉判定打标后入库；
 * 见 agent.sticker.autoDiscover / discoverGroups）。已移除远端仓库克隆/更新。
 */
export class StickerCmd extends plugin {
  constructor() {
    super({
      name: 'agents_表情包',
      dsc: '表情包（自动发现 + 开关）',
      event: 'message',
      priority: 1000,
      rule: [
        { reg: '^#表情包(资源)?状态$', fnc: 'status' },
        { reg: '^#表情包开启$', fnc: 'enable' },
        { reg: '^#表情包关闭$', fnc: 'disable' },
      ],
    })
  }

  async status() {
    if (!this.e.isMaster) return false
    await this.reply(getStickerManager().status())
    return true
  }

  async enable() {
    if (!this.e.isMaster) return false
    const m = getStickerManager()
    m.setEnable(true)
    await this.reply(m.enabled() ? '✅ 表情包已开启' : '✅ 表情包已开启（库为空：开启自动发现 sticker.autoDiscover + 配置 agent.vision.model 后，群内表情会自动入库）')
    return true
  }

  async disable() {
    if (!this.e.isMaster) return false
    getStickerManager().setEnable(false)
    await this.reply('✅ 表情包已关闭（模型不再附带表情包）')
    return true
  }
}

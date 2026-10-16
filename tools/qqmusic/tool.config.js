/**
 * QQ 音乐工具包配置（固定模板）—— 详见工具开发指南「外置工具配置约定」。
 *
 * 用户值统一保存在集中配置 `agent.tools.qqmusic`；此处只声明默认值与表单 schema，
 * web 配置中心会据此动态渲染，无需为工具改前端代码。
 */
export default {
  info: {
    title: 'QQ 音乐',
    description: 'QQ 音乐检索 / 详情 / 歌词 / 榜单 / 歌单（逆向只读接口：L-1124/QQMusicApi、sansenjian/qq-music-api）',
    author: 'trss-agent-plugin',
    version: '1.0.0',
    icon: 'music',
  },
  config: [
    { key: 'enable', type: 'boolean', label: '启用', default: true, description: '关闭后不注册 qqmusic__* 工具，零影响' },
    {
      key: 'cookie', type: 'text', label: '登录 Cookie', default: '', secret: true,
      placeholder: 'uin=o***; qqmusic_key=***; ...',
      description: '获取播放地址/VIP/高音质需要；匿名仅能检索',
    },
    {
      key: 'quality', type: 'enum', label: '默认音质', default: '320',
      options: [
        { value: '128', label: '128kbps MP3' },
        { value: '320', label: '320kbps MP3' },
        { value: 'm4a', label: 'M4A' },
        { value: 'flac', label: 'FLAC' },
        { value: 'ape', label: 'APE' },
      ],
    },
    { key: 'maxResults', type: 'number', label: '搜索默认条数', default: 10, min: 1, max: 30, step: 1 },
    { key: 'timeout', type: 'number', label: '请求超时(ms)', default: 15000, min: 3000, max: 60000, step: 1000 },
    { key: 'sendCard', type: 'boolean', label: '默认发分享卡片', default: true, description: 'qqmusic__song 默认发送 QQ 音乐分享卡片（原生卡片，点击可播放）' },
    { key: 'sendVoice', type: 'boolean', label: '默认发语音', default: false, description: 'qqmusic__song 默认是否把播放链接作为语音发送（发成卡片时不再重复发，除非显式 send=true）' },
  ],
}

/**
 * 哔哩哔哩工具包配置（固定模板）—— 详见插件开发指南「外置工具配置约定」。
 * 用户值统一保存在集中配置 `agent.tools.bilibili`。
 */
export default {
  info: {
    title: '哔哩哔哩',
    description: 'B站视频搜索/详情/内容分析（多模态看视频）/下载/字幕/评论/弹幕/榜单/热门/UP主（逆向接口：SocialSisterYi/bilibili-API-collect）',
    author: 'yunzai-agent-plugin',
    version: '1.0.0',
    icon: 'play',
  },
  config: [
    { key: 'enable', type: 'boolean', label: '启用', default: true, description: '关闭后不注册 bilibili__* 工具，零影响' },
    {
      key: 'cookie', type: 'text', label: '登录 Cookie', default: '', secret: true,
      placeholder: 'SESSDATA=xxx; bili_jct=xxx; ...',
      description: '字幕/UP主空间/高清晰度需要；仅填 SESSDATA 也可。匿名可搜索/详情/播放/评论/弹幕/榜单',
    },
    { key: 'maxResults', type: 'number', label: '搜索默认条数', default: 10, min: 1, max: 30, step: 1 },
    { key: 'timeout', type: 'number', label: '请求超时(ms)', default: 15000, min: 3000, max: 60000, step: 1000 },
    { key: 'sendCard', type: 'boolean', label: '默认发分享卡片', default: true, description: 'bilibili__download 默认发送 B站小程序分享卡片（点击跳转），不下载文件；协议端需支持 json 消息段（NapCat）' },
    { key: 'sendMedia', type: 'boolean', label: '下载后自动发送文件', default: false, description: 'bilibili__download 默认是否额外下载并发送视频/音频文件（工具参数 send_video 可覆盖）' },
    {
      key: 'videoQuality', type: 'enum', label: '默认分辨率', default: '1080',
      options: [
        { value: '360', label: '360P' }, { value: '480', label: '480P' }, { value: '720', label: '720P' },
        { value: '1080', label: '1080P' }, { value: '1080p+', label: '1080P+（需大会员）' },
        { value: '4k', label: '4K（需大会员）' }, { value: '8k', label: '8K（需大会员）' },
      ],
      description: '下载视频时的目标分辨率；大会员档取不到时自动回退到当前账号可用的最高档',
    },
    { key: 'videoFormat', type: 'enum', label: '视频格式', default: 'mp4', options: [{ value: 'mp4', label: 'MP4' }, { value: 'mkv', label: 'MKV' }], description: 'dash 分轨 ffmpeg 合并的输出容器；durl 回退固定 MP4' },
    { key: 'videoCodec', type: 'enum', label: '视频编码偏好', default: 'auto', options: [{ value: 'auto', label: '自动（优先 H.264 兼容）' }, { value: 'avc', label: 'H.264/AVC' }, { value: 'hevc', label: 'H.265/HEVC' }, { value: 'av1', label: 'AV1' }], description: 'dash 同分辨率多编码时的优先选择' },
    { key: 'maxMediaMB', type: 'number', label: '发送大小上限(MB)', default: 80, min: 1, max: 600, step: 1, description: '超过则只返回本地路径不发送' },
    { key: 'enableWatch', type: 'boolean', label: '看视频（多模态）', default: true, description: 'bilibili__analyze 默认下载视频交多模态视觉模型观看（画面+台词 → 带时间线报告），不再依赖字幕/B站AI总结；关=只走字幕/转录' },
    {
      key: 'watchQuality', type: 'enum', label: '看视频分辨率', default: '360',
      options: [{ value: '360', label: '360P' }, { value: '480', label: '480P' }, { value: '720', label: '720P' }],
      description: '观看用低码率（内容看清即可）；越大越慢且更易触发大小上限',
    },
    { key: 'watchMaxMB', type: 'number', label: '看视频大小上限(MB)', default: 40, min: 1, max: 300, step: 1, description: '超过则不送多模态模型（返回原因与建议）' },
    { key: 'watchMaxDurationSec', type: 'number', label: '看视频时长上限(秒)', default: 600, min: 30, max: 3600, step: 30, description: '超过则不观看（小时级视频不适合整段送模型），回退字幕/转录' },
    { key: 'watchMaxTokens', type: 'number', label: '观看报告 token 上限', default: 2048, min: 256, max: 16384, step: 256, description: '多模态模型输出上限；思考型视觉模型建议关思考或加大' },
    { key: 'watchPrompt', type: 'text', label: '看视频指令', default: '', description: '自定义观看指令（留空=内置：主题/时间线/台词/画面要点/不确定处标注）；工具参数 question 会追加为"用户想了解"' },
    { key: 'enableStt', type: 'boolean', label: '看不了时语音转录', default: true, description: 'bilibili__analyze 在看视频不可用且无字幕时，下载音频并用 agent.stt 转录（需配置 agent.stt）' },
  ],
}

/**
 * 自然风格示例（人工认可的「这句话我们会这么说」样本，供 Replyer 少量按场景取用）。
 *
 * 红线：
 *  - 只有带标签的人工样本才会被注入；机器人自己刚生成的消息**绝不**自动收录（防 AI 味自我强化）；
 *  - 每次按当前 ConversationScene 检索 2~4 条，不整本塞进 prompt；
 *  - 排序 = 场景标签匹配 + 熟悉度匹配 (+ 可选语义相似) − 近期用词重复惩罚；贪心 MMR 去冗余；
 *  - embedding 不可用时自动降级为纯标签匹配（零额外调用）。
 *
 * 默认样本对应「默认人设（28 岁女程序员）」的口吻；用户在 persona.styleExamples 提供样本时
 * 完整替换默认集（自定义 persona 全量覆盖默认值）。
 */

import { textSim, textFeatures } from '../groupworld/embedding.js'

/**
 * 默认风格样本（sceneType/speechAct/tone/familiarity 标签 + text）。
 * familiarity: 0=陌生人 0.5=一般群友 1=熟人损友。
 */
export const DEFAULT_STYLE_EXAMPLES = Object.freeze([
  { sceneType: 'banter', speechAct: 'tease', tone: 'playful', familiarity: 1, text: '就这？我上我也行' },
  { sceneType: 'banter', speechAct: 'tease', tone: 'playful', familiarity: 1, text: '你可拉倒吧，上次谁说请奶茶来着' },
  { sceneType: 'banter', speechAct: 'tease', tone: 'sarcastic', familiarity: 1, text: '行行行，你最厉害，我们都菜' },
  { sceneType: 'banter', speechAct: 'tease', tone: 'playful', familiarity: 0.5, text: '哈哈哈哈绷不住了' },
  { sceneType: 'venting', speechAct: 'complain', tone: 'tired', familiarity: 0.5, text: '唉，周一就是这样，熬吧' },
  { sceneType: 'venting', speechAct: 'complain', tone: 'tired', familiarity: 1, text: '正常，它就爱挑你下班的时候炸' },
  { sceneType: 'venting', speechAct: 'complain', tone: 'playful', familiarity: 1, text: '建议直接物理超度那台服务器' },
  { sceneType: 'venting', speechAct: 'complain', tone: 'tired', familiarity: 0.5, text: '辛苦了，这玩意最磨人' },
  { sceneType: 'serious_qna', speechAct: 'ask', tone: 'serious', familiarity: 0.5, text: '这个我之前踩过，日志里搜下 oom，八成是内存不够了' },
  { sceneType: 'serious_qna', speechAct: 'ask', tone: 'serious', familiarity: 0.5, text: 'P40 跑 7B 没问题，再大就费劲了，显存摆在那' },
  { sceneType: 'serious_qna', speechAct: 'ask', tone: 'serious', familiarity: 1, text: '能跑，但你别指望速度，图个能用的水平' },
  { sceneType: 'comfort', speechAct: 'inform', tone: 'serious', familiarity: 0.5, text: '没事，慢慢来，不差这一天' },
  { sceneType: 'comfort', speechAct: 'inform', tone: 'serious', familiarity: 1, text: '摸摸，先去睡，明天再看它就没那么难了' },
  { sceneType: 'storytelling', speechAct: 'share', tone: 'playful', familiarity: 0.5, text: '然后呢？别停在这啊' },
  { sceneType: 'storytelling', speechAct: 'share', tone: 'playful', familiarity: 1, text: '好家伙，这剧情比我周一还离谱' },
  { sceneType: 'debate', speechAct: 'inform', tone: 'serious', familiarity: 0.5, text: '先不站队，等个实测再说' },
  { sceneType: 'coordination', speechAct: 'invite', tone: 'serious', familiarity: 0.5, text: '算我一个，几点？' },
  { sceneType: 'repair', speechAct: 'inform', tone: 'awkward', familiarity: 1, text: '害，刚才那话我没往心里去，别在意' },
  { sceneType: 'idle', speechAct: 'close_topic', tone: 'serious', familiarity: 0.5, text: '好，先这样，回见' },
  { sceneType: 'idle', speechAct: 'close_topic', tone: 'tired', familiarity: 1, text: '行，我也溜了，晚安' },
])

/**
 * 按当前场景挑选 2~4 条风格示例。
 * @param {Array} examples 带标签样本（缺省用 DEFAULT_STYLE_EXAMPLES）
 * @param {object} scene ConversationScene（可为 null → 按 familiarity/去重挑中性样本）
 * @param {object} o { familiarity?:0~1, recentBotTexts?:string[], queryText?:string, count?:2~4, embedder? }
 *   familiarity 当前对话对象的熟悉度（近窗出现多 = 熟）；recentBotTexts 用于重复惩罚（近词不再推同款）。
 */
export function pickStyleExamples(examples, scene, { familiarity = 0.5, recentBotTexts = [], queryText = '', count = 3 } = {}) {
  const pool = (Array.isArray(examples) && examples.length ? examples : DEFAULT_STYLE_EXAMPLES)
    .filter((e) => e && typeof e.text === 'string' && e.text.trim())
  if (!pool.length) return []
  const n = Math.max(2, Math.min(4, count | 0 || 3))
  const fam = Math.max(0, Math.min(1, Number(familiarity) || 0))
  const recentFeats = recentBotTexts.filter(Boolean).map((t) => textFeatures(String(t).slice(0, 120)))

  const scored = pool.map((e) => {
    // 标签匹配：sceneType 1.0 / speechAct 0.6 / tone 命中各 0.25
    let tag = 0
    if (scene) {
      if (e.sceneType === scene.sceneType) tag += 1
      if (e.speechAct === scene.speechAct) tag += 0.6
      const tones = scene.tones || []
      if (tones.includes(e.tone)) tag += 0.25
      else if (tones.length) tag -= 0.1
    }
    // 熟悉度接近度
    const exFam = Number.isFinite(Number(e.familiarity)) ? Number(e.familiarity) : 0.5
    const famScore = 1 - Math.abs(exFam - fam)
    // 可选语义相似（词面零成本；有 queryText 才算）
    const sem = queryText ? textSim(String(queryText).slice(0, 100), e.text) : 0
    // 重复惩罚：与近期 bot 输出词面重叠度高 → 这款表达刚用过，别再推
    let repeat = 0
    const feats = [...textFeatures(e.text)]
    for (const rf of recentFeats) {
      if (!feats.length || rf.size === 0) continue
      let hit = 0
      for (const f of feats) if (rf.has(f)) hit++
      repeat = Math.max(repeat, hit / feats.length)
    }
    const score = tag * 0.6 + famScore * 0.25 + sem * 0.3 - repeat * 1.2
    return { e, score }
  }).sort((a, b) => b.score - a.score)

  // 贪心 MMR：与已选样本词面过近（≥0.6）的跳过，保证几条例子彼此不同款
  const picked = []
  for (const { e } of scored) {
    if (picked.length >= n) break
    if (picked.some((p) => textSim(p.text, e.text) >= 0.6)) continue
    picked.push(e)
  }
  return picked
}

/** 检索结果 → prompt 注入块（少量、带标签说明、明确「仅供参考别照搬」）。 */
export function formatStyleExamples(picked, { identityName = '' } = {}) {
  if (!Array.isArray(picked) || !picked.length) return ''
  const lines = picked.map((e) => {
    const tags = [e.sceneType, e.speechAct, e.tone, e.familiarity >= 0.8 ? '熟人' : e.familiarity <= 0.3 ? '生人' : '一般'].filter(Boolean).join('/')
    return `- （${tags}）${e.text}`
  })
  return `【${identityName || '你'}偶尔说话的样例（体会语气与长度即可，禁止照抄原句或硬凑同款）】\n${lines.join('\n')}`
}

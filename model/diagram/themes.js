/**
 * 主题定义 —— 五套固定主题，渲染三端（D2/Kroki、本地 Mermaid、resvg 背景）共用同一份色板。
 *
 * 配色约束（仓库约定）：红/绿对比禁用；主对为蓝/橙，语义区分叠加线型/形状冗余。
 *   - error 连线用深橙（非红），async/dependency 用虚线/点线（线型冗余），不依赖色相区分。
 *
 * d2Theme 为 Kroki D2 option `theme` 的编号，集中定义、禁止 LLM 传入数字；
 * 编号依据 D2 内置主题表，真实容器联调（KROKI_INTEGRATION=1）时核对色调，改动需 bump THEME_MAP_VERSION 使缓存失效。
 */

export const THEME_NAMES = ['paper-blue', 'soft-pastel', 'technical', 'midnight', 'sketch']

/** 主题映射版本（参与缓存 key）：改色板/D2 编号/sketch 行为必须 +1，使旧缓存全部失效 */
export const THEME_MAP_VERSION = 1

export const THEMES = {
  // 米白纸蓝：帮助图与说明文档
  'paper-blue': {
    label: '米白纸蓝',
    bg: '#FAF9F6', fg: '#2D3748',
    accent: '#2563EB', line: '#94A3B8',
    surface: '#EFF6FF', border: '#BFDBFE',
    edge: '#475569', error: '#C2410C',
    dark: false,
    d2: { theme: 4, sketch: false }, // D2 "Basic Light" 系浅色
  },
  // 柔和低饱和：产品与关系示意
  'soft-pastel': {
    label: '柔和粉彩',
    bg: '#FDF8F3', fg: '#44403C',
    accent: '#D97706', line: '#D6CFC7',
    surface: '#FFF7ED', border: '#FED7AA',
    edge: '#A8A29E', error: '#B45309',
    dark: false,
    d2: { theme: 100, sketch: false }, // D2 "Origami" 系柔和
  },
  // 白底技术蓝灰：系统架构
  'technical': {
    label: '技术蓝灰',
    bg: '#FFFFFF', fg: '#1E293B',
    accent: '#0369A1', line: '#CBD5E1',
    surface: '#F1F5F9', border: '#94A3B8',
    edge: '#475569', error: '#C2410C',
    dark: false,
    d2: { theme: 1, sketch: false }, // D2 "Neutral Gray"
  },
  // 深色高对比：Web 暗色模式
  'midnight': {
    label: '午夜深色',
    bg: '#0F172A', fg: '#E2E8F0',
    accent: '#60A5FA', line: '#475569',
    surface: '#1E293B', border: '#475569',
    edge: '#94A3B8', error: '#FB923C',
    dark: true,
    d2: { theme: 200, sketch: false }, // D2 "Midnight Blues" 系深色
  },
  // 手绘风：仅 D2 后端可用；本地 Mermaid 回退到 paper-blue
  'sketch': {
    label: '手绘素描',
    bg: '#FDFCF8', fg: '#3F3A34',
    accent: '#2563EB', line: '#A8A29E',
    surface: '#F5F1E8', border: '#D6CFC7',
    edge: '#57534E', error: '#B45309',
    dark: false,
    d2: { theme: 4, sketch: true },
  },
}

export const DEFAULT_THEME = 'paper-blue'

/** 取主题；未知名回落 DEFAULT_THEME。sketch 在非 D2 引擎回落 paper-blue（本地 Mermaid 无手绘风）。 */
export function resolveTheme(name, { engine = 'd2' } = {}) {
  const key = THEME_NAMES.includes(name) ? name : DEFAULT_THEME
  if (key === 'sketch' && engine !== 'd2') {
    return { theme: THEMES[DEFAULT_THEME], fallbackFrom: 'sketch', key: DEFAULT_THEME }
  }
  return { theme: THEMES[key], fallbackFrom: null, key }
}

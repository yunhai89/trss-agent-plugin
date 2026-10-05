/**
 * ESLint 配置（审计 §8 P1）。
 * 存量代码体量大，先用宽松配置：保留高价值规则（no-undef 必 error），其余 warn/off，
 * 避免一次性海量风格错误阻塞 CI。目标：① CI lint 能跑通；② 新增代码不恶化。
 * 后续可逐步收紧规则 + 修复存量，过渡到阻塞式 lint。
 */
module.exports = {
  root: true,
  env: { node: true, es2022: true },
  // Yunzai 运行时注入的全局对象（非 import，声明 readonly 避免 no-undef 误报）
  globals: {
    Bot: 'readonly',
    segment: 'readonly',
    logger: 'readonly',
    redis: 'readonly',
    // Node 18+ 全局 fetch API（provider/mcp/search 上传/流式用到）
    fetch: 'readonly',
    Response: 'readonly',
    Request: 'readonly',
    Headers: 'readonly',
    FormData: 'readonly',
    Blob: 'readonly',
    ReadableStream: 'readonly',
    TextEncoder: 'readonly',
    TextDecoder: 'readonly',
    // 浏览器 DOM：仅 puppeteer evaluate 字符串上下文引用，node 端不执行
    document: 'readonly',
  },
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  ignorePatterns: [
    'node_modules/',
    'web/',          // 前端代码（浏览器 ESM），单独配置
    'data/',
    'temp/',
    'resources/',
    'pnpm-lock.yaml',
    '*.md',
  ],
  rules: {
    // 高价值：未定义变量必须报错（捕拼写错误 / 漏 import）
    'no-undef': 'error',
    // 存量温和提示（warn 不阻塞）
    'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'no-empty': ['warn', { allowEmptyCatch: true }],
    // 存量普遍存在、先关闭避免噪声（后续逐步收紧）
    'no-unused-expressions': 'off',
    'no-cond-assign': 'off',
    'no-constant-condition': 'off',
    'prefer-const': 'off',
    'no-var': 'off',
    'eqeqeq': 'off',
    'no-async-promise-executor': 'off',
    'no-useless-escape': 'off',
    'no-prototype-builtins': 'off',
    'no-inner-declarations': 'off',
    'no-fallthrough': 'off',
    'no-control-regex': 'off',
    'no-misleading-character-class': 'off',
    'no-irregular-whitespace': 'off',
    'no-unsafe-finally': 'off',
    'no-loss-of-precision': 'off',
    'no-useless-backreference': 'off',
  },
}

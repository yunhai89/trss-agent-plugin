/**
 * 静态资源版本化回归：index.html 本地资源 URL 必须带 ?v=版本（防发版后旧 JS 缓存致页面异常）。
 * 运行：node model/web/asset-version.test.mjs
 */
import { versionAssetUrls } from './asset-version.js'

let passed = 0, failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
const test = (name, fn) => { console.log(`\n[${name}]`); try { fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e) } }

const HTML = [
  '<link rel="stylesheet" href="assets/css/main.css">',
  '<script src="vendor/vue.global.prod.js"></script>',
  '<script src="assets/js/store.js"></script>',
  '<script src="assets/js/views/suggestions.js"></script>',
  '<link rel="icon" href="data:image/svg+xml,<svg></svg>">',
  '<a href="https://example.com/x.js"></a>',
].join('\n')

test('本地 assets/vendor 追加 ?v=版本', () => {
  const out = versionAssetUrls(HTML, '1.13.4')
  ok(out.includes('href="assets/css/main.css?v=1.13.4"'), 'css 版本化')
  ok(out.includes('src="vendor/vue.global.prod.js?v=1.13.4"'), 'vendor 版本化')
  ok(out.includes('src="assets/js/store.js?v=1.13.4"'), 'store.js 版本化')
  ok(out.includes('src="assets/js/views/suggestions.js?v=1.13.4"'), 'suggestions.js 版本化（本次空白 bug 的旧缓存文件）')
})

test('data:/外部 URL 不动', () => {
  const out = versionAssetUrls(HTML, '1.0.0')
  ok(out.includes('href="data:image/svg+xml,<svg></svg>"'), 'data: URL 原样')
  ok(out.includes('href="https://example.com/x.js"'), '外链原样')
  ok(!/data:[^"]*\?v=/.test(out), 'data: URL 未加版本')
})

test('幂等：已带 ?v= 不重复追加', () => {
  const once = versionAssetUrls(HTML, '2.0.0')
  const twice = versionAssetUrls(once, '2.0.0')
  ok(once === twice, '二次应用结果一致')
  ok((twice.match(/\?v=2\.0\.0/g) || []).length === (once.match(/\?v=2\.0\.0/g) || []).length, '无重复 ?v=')
})

test('空版本原样返回；空 HTML 安全', () => {
  ok(versionAssetUrls(HTML, '') === HTML, '空版本不改')
  ok(versionAssetUrls(null, '1.0.0') === '', 'null → 空串')
})

console.log('\n========================================')
console.log(`通过 ${passed}，失败 ${failed}`)
console.log('========================================')
if (failed > 0) process.exitCode = 1

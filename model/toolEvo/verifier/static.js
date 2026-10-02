/**
 * 静态验证（文档 §14）：typescript Compiler API 扫候选 source 的禁用模式 + manifest 校验。
 *
 * 仅作前置门禁——AST 检查不能替代隔离执行（node:vm 官方明确不是安全边界）。本层尽量覆盖
 * 别名、计算属性、构造器链、重导出、字符串模块名与语法错误等相邻逃逸路径；运行时仍由
 * 隔离执行面（unshare -n + Node 权限模型 / E2B）兜底。
 * 第一版策略：候选是纯函数，默认禁一切 import、禁访问宿主全局与动态代码。
 */
import ts from 'typescript'
import { validateManifest } from '../manifest.js'

/** 禁止 import 的模块（第一版只允许纯函数，默认禁所有 import） */
const ALLOWED_IMPORTS = new Set([])

/** 禁止作为表达式引用的危险全局标识符（别名/引用一律拦下） */
const DANGEROUS_IDENTIFIERS = new Set([
  'process', 'globalThis', 'global', 'window', 'self', 'require', 'module', 'exports',
  'eval', 'Function', 'AsyncFunction', 'GeneratorFunction', 'WebAssembly', 'Worker',
  'fetch', 'WebSocket', 'XMLHttpRequest', 'EventSource', 'navigator', 'importScripts',
  'createRequire', '__dirname', '__filename',
])

/** 禁止出现的危险模块名（含计算属性/字符串拼接出的模块名） */
const DANGEROUS_MODULES = [
  /child_process/, /node:child_process/, /node:fs/, /node:fs\/promises/, /node:net/,
  /node:http/, /node:https/, /node:tls/, /node:dgram/, /node:worker_threads/, /node:vm/,
  /node:module/, /node:process/, /node:os/, /node:cluster/, /node:inspector/,
]

/** 标识符是否只是“名字位置”（属性名/键/声明名/导入名）——这些不算宿主引用 */
function isMemberOrName(node) {
  const p = node.parent
  if (!p) return false
  if ((ts.isPropertyAccessExpression(p) || ts.isQualifiedName(p)) && p.name === node) return true
  if (ts.isPropertyAssignment(p) && p.name === node) return true
  if (ts.isShorthandPropertyAssignment(p) && p.name === node) return true
  if ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p) || ts.isBindingElement(p)) && p.name === node) return true
  if (ts.isImportSpecifier(p) && (p.name === node || p.propertyName === node)) return true
  if (ts.isExportSpecifier(p) && (p.name === node || p.propertyName === node)) return true
  return false
}

/** 扫描 source 的禁用模式 → violations[] */
export function scanSource(source) {
  const violations = []
  const text = String(source || '')
  const sf = ts.createSourceFile('candidate.js', text, ts.ScriptTarget.ES2023, true, ts.ScriptKind.JS)
  // 语法错误：解析不完整/非法语法也要拦（否则可能出现半截代码）
  for (const d of (sf.parseDiagnostics || [])) {
    violations.push('语法错误：' + ts.flattenDiagnosticMessageText(d.messageText, ' '))
  }
  let sawRunExport = false
  const visit = (node) => {
    // import 非白名单
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!ALLOWED_IMPORTS.has(node.moduleSpecifier.text)) violations.push(`禁止 import：${node.moduleSpecifier.text}（候选须零依赖纯函数）`)
    }
    // 重导出 export ... from '...'（绕过 import 检查的相邻路径）
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      violations.push('禁止重导出（export ... from）')
    }
    // 危险标识符引用（覆盖别名：const p = process; globalThis['pro'+'cess'] 的基对象）
    if (ts.isIdentifier(node) && DANGEROUS_IDENTIFIERS.has(node.text) && !isMemberOrName(node)) {
      violations.push(`禁止引用宿主全局：${node.text}`)
    }
    // 构造器链逃逸：x.constructor / x['constructor']
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'constructor') {
      violations.push('禁止访问 constructor（构造器链可逃逸隔离）')
    }
    if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === 'constructor') {
      violations.push('禁止访问 constructor（构造器链可逃逸隔离）')
    }
    // 动态代码/装载
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && ['require', 'eval', 'Function'].includes(node.expression.text)) {
        violations.push(`禁止调用：${node.expression.text}`)
      }
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) violations.push('禁止动态 import')
    }
    if ((ts.isNewExpression(node)) && ts.isIdentifier(node.expression) && node.expression.text === 'Function') {
      violations.push('禁止 Function 构造（动态代码，可逃逸隔离）')
    }
    // 危险模块名字符串（含计算属性字符串拼接出的名字）
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && typeof node.text === 'string') {
      for (const re of DANGEROUS_MODULES) if (re.test(node.text)) { violations.push(`禁止使用危险模块：${node.text}`); break }
    }
    // run 导出标记
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'run' &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
      sawRunExport = true
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return { violations, sawRunExport }
}

/**
 * 全量静态验证。
 * @param {object} p { manifest, source }
 * @returns { passed:boolean, violations:string[] }
 */
export function verifyStatic({ manifest, source }) {
  const violations = []
  // 1. manifest schema
  const mv = validateManifest(manifest)
  if (!mv.ok) violations.push(...mv.errors.map((e) => 'manifest: ' + e))
  // 2. source 必须导出 async function run，且语法可利用
  const scanned = scanSource(String(source || ''))
  violations.push(...scanned.violations)
  if (!/export\s+async\s+function\s+run\s*\(/.test(String(source || '')) || !scanned.sawRunExport) {
    violations.push('source 必须导出：export async function run(input, ctx)')
  }
  return { passed: violations.length === 0, violations }
}

export default { scanSource, verifyStatic }

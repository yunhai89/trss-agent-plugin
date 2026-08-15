// 真 LLM 端到端压测入口包装：先定临时目录（桩在模块初始化时读 E2E_TMP），再载真正的驱动。
// 用法：node --import ./stress/e2e/hooks.mjs stress/anti-misread/run-real.mjs <场景> <运行序号>
//   场景：R1（门控行为，生产 threshold）/ R1F（强制进 Planner）/ R2（云海渗入，强制）/
//         R3（对象纠错）/ R4（正常提问回归）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `anti-misread-${process.pid}-`))
process.env.E2E_TMP = TMP
process.env.ANTI_MISREAD_ARGS = JSON.stringify(process.argv.slice(2))
console.log(`[anti-misread] TMP=${TMP}`)
await import(path.join(import.meta.dirname, 'real-llm.mjs'))

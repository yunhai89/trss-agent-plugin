// E2E 入口包装：先定临时目录（桩在模块初始化时读 E2E_TMP），再载真正的驱动。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `e2e-fullchain-${process.pid}-`))
process.env.E2E_TMP = TMP
console.log(`[e2e] TMP=${TMP}`)
await import(path.join(import.meta.dirname, 'e2e-fullchain.mjs'))

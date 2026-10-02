/**
 * toolEvo stable 工具隔离执行 worker（子进程入口）。
 *
 * 由 RunnerClient 以 `unshare -n node --permission --allow-fs-read=<workDir,workerDir>` 启动：
 *   - 无网络命名空间出口、无文件写、无 child_process/worker；
 *   - 本进程再削弱宿主全局（getBuiltinModule/binding/dlopen/fetch/...），只加载私有工作目录里的
 *     不可变 source（宿主已按 content_hash 校验并落盘为只读）。
 * 通过 IPC 收 {id, artifactPath, params} → import 制品的 run → 用冻结 capabilityCtx 调用。
 */
const cache = new Map() // artifactPath → mod

// 纵深防御：删除可获取宿主能力的全局（权限模型已挡 fs/child，此处削弱网络/动态加载入口）
try { delete process.getBuiltinModule } catch { /* noop */ }
try { delete process.binding } catch { /* noop */ }
try { delete process.dlopen } catch { /* noop */ }
try { delete process._linkedBinding } catch { /* noop */ }
for (const g of ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest', 'require']) {
  try { delete globalThis[g] } catch { /* noop */ }
}

process.on('message', async (msg) => {
  if (!msg || !msg.id) return
  const { id, artifactPath, params } = msg
  try {
    let mod = cache.get(artifactPath)
    if (!mod) { mod = await import(artifactPath); cache.set(artifactPath, mod) }
    if (typeof mod.run !== 'function') {
      return process.send({ id, ok: false, error: '工具制品未导出 run 函数' })
    }
    // 冻结的 capability ctx：仅 now/log，无任何宿主能力
    const ctx = Object.freeze({
      now: () => new Date().toISOString(),
      log: (...a) => { try { process.send({ type: 'log', id, args: a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))) }) } catch { /* noop */ } },
    })
    const output = await mod.run(params, ctx)
    process.send({ id, ok: true, output })
  } catch (e) {
    process.send({ id, ok: false, error: e?.message || String(e), errorClass: e?.name || 'Error' })
  }
})

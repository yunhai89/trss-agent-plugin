/**
 * Tool Evolution 子系统对外出口（阶段0：DB + Manifest + Lifecycle + Registry）。
 *
 * 挂载：apps/agent.js 进化三件套位置 new ToolEvoRegistry + initDb，放进 getRuntime()。
 * 后续阶段在此扩出口：synthesizer / verifier / sandbox / evaluator / engine。
 */
export { getDb, initDb, closeDb, dao, recordInvocation, flushNow } from './db.js'
export { ToolEvoRegistry } from './registry.js'
export { validateManifest, isGenerationAllowed, makeManifest, NAME_RE, SEMVER_RE } from './manifest.js'
export { seedBuiltinTools } from './seed.js'
export { ToolSynthesizer } from './synthesizer.js'
export { default as verifyStatic, scanSource } from './verifier/static.js'
export { runCandidate, createLocalCandidateSession, createSandboxCandidateSession } from './sandbox.js'
export { verifyBehavior } from './verifier/behavior.js'
export { EvolutionEngine } from './engine.js'
export { RunnerClient } from './runner.js'
export * as lifecycle from './lifecycle.js'

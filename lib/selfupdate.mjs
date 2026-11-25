// 跟随 DSH 版本自更新 —— 只更新「这个插件自己」，永远不动 DSH 的版本。
//
// 为什么单独一块：DSH 每次升级（app.asar 里的核心版本变了），插件可能需要跟着改；
// 但「插件跟着改」和「升级 DSH」是两件事，混在一起就会重演 2026-11-24 那次事故
// （装插件时把依赖整批换版本，核心却还是旧的）。
//
// 这里定死三条边界：
//   1. 只改「本插件目录」——git pull 自己的仓库；**绝不** 写 profile 的 package.json，
//      **绝不** 动任何 @deepseek-ai/* 的版本号，也不跑 pnpm。
//   2. 默认「只记录 + 报告」，`enabled: false` 时连 git pull 都不做，只在状态文件里记一笔。
//   3. 任何一步失败都不抛给调用方，返回结构化结果，交给上层展示。

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync, mkdirSync } from 'node:fs'
import { run } from './sys.mjs'
import { readCoreVersion, readCoreVersionViaNode } from './asar.mjs'
import { readJsonSafe } from './context.mjs'

const BUNDLE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const GIT_CANDIDATES = [
  process.env.DSH_DOCTOR_GIT || '',
  'C:\\Users\\Administrator\\.dsh\\tools\\mingit\\cmd\\git.exe',
  'C:\\Program Files\\Git\\cmd\\git.exe',
]

function findGit() {
  for (const p of GIT_CANDIDATES) if (p && existsSync(p)) return p
  return 'git'
}

export function readState(ctx) {
  return readJsonSafe(ctx.stateFile) ?? {}
}

export function writeState(ctx, patch) {
  const next = { ...readState(ctx), ...patch }
  try {
    mkdirSync(dirname(ctx.stateFile), { recursive: true })
    writeFileSync(ctx.stateFile, JSON.stringify(next, null, 2), 'utf8')
  } catch { /* 状态文件写不进去不影响主流程 */ }
  return next
}

/** 插件目录是不是一个带远端的 git 仓库（是才能自更新）。 */
export async function detectRepo() {
  const git = findGit()
  const out = { git, dir: BUNDLE_DIR, isGit: false, remote: '', branch: '', dirty: false, head: '' }
  if (!existsSync(join(BUNDLE_DIR, '.git'))) return out
  out.isGit = true
  try {
    const r = await run(git, ['-C', BUNDLE_DIR, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 20000 })
    out.branch = String(r.stdout || '').trim()
    const rem = await run(git, ['-C', BUNDLE_DIR, 'config', '--get', 'remote.origin.url'], { timeout: 20000 })
    out.remote = String(rem.stdout || '').trim()
    const head = await run(git, ['-C', BUNDLE_DIR, 'rev-parse', '--short', 'HEAD'], { timeout: 20000 })
    out.head = String(head.stdout || '').trim()
    const st = await run(git, ['-C', BUNDLE_DIR, 'status', '--porcelain'], { timeout: 20000 })
    out.dirty = String(st.stdout || '').trim().length > 0
  } catch { /* 读不到就按非 git 处理 */ }
  return out
}

/**
 * 检查并（可选）跟随更新。
 * @param {object} ctx
 * @param {{ apply?: boolean, enabled?: boolean }} opts apply=false 时只报告
 */
export async function checkSelfUpdate(ctx, opts = {}) {
  const cfg = ctx.selfUpdate ?? {}
  const stateNow = readState(ctx)
  // 开关优先级：本次显式传参 > 工具留下的持久开关 > 配置
  const enabled = opts.enabled !== undefined
    ? !!opts.enabled
    : (stateNow.selfUpdateDisabled === true ? false : cfg.enabled !== false)
  const apply = opts.apply !== false && enabled
  let core = readCoreVersion(ctx.asarPath)
  if (!core.ok) { const alt = readCoreVersionViaNode(ctx.asarPath, ctx.nodeExe); if (alt.ok) core = alt }
  const state = readState(ctx)
  const lastCore = String(state.lastCoreVersion || '')
  const result = {
    at: new Date().toISOString(),
    enabled,
    coreVersion: core.ok ? core.version : null,
    coreSource: core.ok ? core.from : null,
    lastCoreVersion: lastCore,
    coreChanged: !!(core.ok && lastCore && lastCore !== core.version),
    firstRun: !!(core.ok && !lastCore),
  }
  const repo = await detectRepo()
  result.repo = { isGit: repo.isGit, remote: repo.remote, branch: repo.branch, head: repo.head, dirty: repo.dirty }

  if (!core.ok) return { ...result, updated: false, note: `读不到核心版本：${core.error}` }
  if (!result.coreChanged && !result.firstRun) {
    writeState(ctx, { lastCheckAt: result.at, lastResult: 'no-change' })
    return { ...result, updated: false, note: 'DSH 版本没变，不用动' }
  }
  if (!enabled) {
    writeState(ctx, { lastCoreVersion: core.version, lastCheckAt: result.at, lastResult: 'disabled', prevCoreVersion: lastCore })
    return { ...result, updated: false, note: `检测到核心版本 ${lastCore || '(首次)'} → ${core.version}，但自更新已禁用（只记录）` }
  }
  if (!repo.isGit || !repo.remote) {
    writeState(ctx, { lastCoreVersion: core.version, lastCheckAt: result.at, lastResult: 'no-git' })
    return { ...result, updated: false, note: '插件目录不是带远端的 git 仓库，无法自动拉取（只记录版本）' }
  }
  if (!apply) {
    return { ...result, updated: false, wouldUpdate: true, note: '演练：会 git pull --ff-only（未执行）' }
  }
  if (repo.dirty) {
    writeState(ctx, { lastCheckAt: result.at, lastResult: 'dirty' })
    return { ...result, updated: false, note: '插件目录有未提交改动，跳过自动更新（避免覆盖）' }
  }

  // 只 pull 自己；--ff-only 保证不会产生意外的合并提交
  const r = await run(repo.git, ['-C', BUNDLE_DIR, 'pull', '--ff-only'], { timeout: 180000 })
  const after = await detectRepo()
  const ok = r.code === 0
  writeState(ctx, {
    lastCoreVersion: core.version,
    prevCoreVersion: lastCore || '',
    lastCheckAt: result.at,
    lastUpdateAt: ok ? result.at : state.lastUpdateAt,
    lastResult: ok ? 'pulled' : 'pull-failed',
    lastPull: { code: r.code, tail: String(r.stdout || r.stderr || '').split(/\r?\n/).filter(Boolean).slice(-4).join(' | ') },
  })
  return {
    ...result,
    updated: ok && after.head !== repo.head,
    headBefore: repo.head,
    headAfter: after.head,
    note: ok
      ? (after.head !== repo.head ? `已更新到 ${after.head}（下次重启 DSH 生效）` : '已是最新')
      : `git pull 失败：${String(r.stderr || r.stdout || '').slice(-200)}`,
  }
}

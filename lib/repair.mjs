// 修复层：决策树 + 实际动作。每个写操作前先留证据，失败也不中断后续步骤。

import {
  copyFileSync, existsSync, mkdirSync, readFileSync,
  rmSync, statSync, unlinkSync, writeFileSync, openSync, closeSync,
} from 'node:fs'
import { join } from 'node:path'
import { launchDetached, psJson, run, sleep, toArray } from './sys.mjs'
import { readJsonSafe } from './context.mjs'
import { collectChecks, summarizeDiag } from './checks.mjs'
import { getBridgeStatus, getHostProcesses, listSnapshots, probeHost } from './host.mjs'

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const LOCK_STALE_MS = 15 * 60_000

/* ── 锁：看护任务和你手点不能同时改同一个 profile ────────────────────── */
async function withLock(ctx, fn) {
  try {
    mkdirSync(ctx.qqAgentDir, { recursive: true })
  } catch { /* ignore */ }
  let fd
  try {
    fd = openSync(ctx.lockFile, 'wx')
    writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
    closeSync(fd)
    fd = undefined
  } catch {
    // 已存在：超过 15 分钟当作陈旧锁
    let age = Infinity
    try { age = Date.now() - statSync(ctx.lockFile).mtimeMs } catch { /* ignore */ }
    if (age < LOCK_STALE_MS) return { ok: false, busy: true, detail: `另一个修复正在跑（${ctx.lockFile}）`, steps: [] }
    try { unlinkSync(ctx.lockFile) } catch { /* ignore */ }
    try {
      fd = openSync(ctx.lockFile, 'wx')
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), tookStale: true }))
      closeSync(fd)
      fd = undefined
    } catch {
      return { ok: false, busy: true, detail: '拿不到锁', steps: [] }
    }
  }
  try {
    return await fn()
  } finally {
    try { unlinkSync(ctx.lockFile) } catch { /* ignore */ }
  }
}

/* ── 快照 ───────────────────────────────────────────────────────────── */
export function takeSnapshot(ctx, tag = 'manual') {
  const dir = join(ctx.snapshotsDir, `${stamp()}-${tag}`)
  try {
    mkdirSync(dir, { recursive: true })
    const copied = []
    for (const [src, name] of [[ctx.profilePkg, 'package.json'], [ctx.profilePatch, 'cordis.patch.yml']]) {
      if (existsSync(src)) {
        copyFileSync(src, join(dir, name))
        copied.push(name)
      }
    }
    const meta = {
      tag,
      at: new Date().toISOString(),
      profileDir: ctx.profileDir,
      files: copied,
      processName: ctx.processName,
    }
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(meta, null, 2), 'utf8')
    pruneSnapshots(ctx)
    return { ok: true, dir, files: copied }
  } catch (e) {
    return { ok: false, dir, detail: String(e?.message || e) }
  }
}

function pruneSnapshots(ctx) {
  try {
    const list = listSnapshots(ctx)
    for (const s of list.slice(Math.max(1, ctx.keepSnapshots))) {
      try { rmSync(s.dir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

/* ── 版本对齐 / 重装 / 恢复配置 ─────────────────────────────────────── */
export function fixVersions(ctx, versions) {
  const core = versions?.core
  if (!core?.ok) return { ok: false, changed: [], detail: '读不到核心版本，不敢改' }
  let raw
  try { raw = readFileSync(ctx.profilePkg, 'utf8') } catch (e) { return { ok: false, changed: [], detail: String(e?.message || e) } }
  const hadBom = raw.charCodeAt(0) === 0xFEFF
  const body = hadBom ? raw.slice(1) : raw
  const changed = []
  let next = body
  for (const dep of versions.drift || []) {
    const from = `"${dep.name}": "${dep.declared}"`
    const to = `"${dep.name}": "${core.version}"`
    if (next.includes(from)) {
      next = next.split(from).join(to)
      changed.push(`${dep.name}: ${dep.declared} -> ${core.version}`)
    }
  }
  if (!changed.length) return { ok: true, changed, detail: '没有需要改的' }
  try {
    copyFileSync(ctx.profilePkg, `${ctx.profilePkg}.bak-doctor-${stamp()}`)
    writeFileSync(ctx.profilePkg, (hadBom ? '\uFEFF' : '') + next, 'utf8')
    return { ok: true, changed, detail: changed.join('；') }
  } catch (e) {
    return { ok: false, changed: [], detail: String(e?.message || e) }
  }
}

export async function runInstall(ctx, opts = {}) {
  if (!ctx.pnpmCli || !existsSync(ctx.pnpmCli)) {
    return { ok: false, detail: `找不到 pnpm：${ctx.pnpmCli || '（未发现 DSH 安装目录）'}`, skipped: true }
  }
  const r = await run(ctx.nodeExe, [ctx.pnpmCli, 'install', '--reporter=append-only'], {
    cwd: ctx.profileDir,
    timeout: opts.timeout ?? 600_000,
    maxBuffer: 3_000_000,
  })
  const tail = String(r.stdout || '').trim().split(/\r?\n/).slice(-6).join(' ｜ ') ||
    String(r.stderr || '').trim().split(/\r?\n/).slice(-4).join(' ｜ ')
  return {
    ok: r.code === 0 && !r.timedOut,
    code: r.code,
    timedOut: !!r.timedOut,
    detail: r.timedOut ? `pnpm install 超时（${Math.round((opts.timeout ?? 600_000) / 1000)}s）` : `pnpm install exit=${r.code}${tail ? ' · ' + tail : ''}`,
  }
}

export function restoreConfigs(ctx, snapshot) {
  if (!snapshot) return { ok: false, detail: '没有可用快照' }
  const restored = []
  try {
    for (const [name, dest] of [['package.json', ctx.profilePkg], ['cordis.patch.yml', ctx.profilePatch]]) {
      const src = join(snapshot.dir, name)
      if (!existsSync(src)) continue
      if (existsSync(dest)) copyFileSync(dest, `${dest}.bak-doctor-${stamp()}`)
      copyFileSync(src, dest)
      restored.push(name)
    }
    return restored.length
      ? { ok: true, detail: `已从 ${snapshot.name} 恢复 ${restored.join('、')}` }
      : { ok: false, detail: `快照 ${snapshot.name} 里没有可恢复的文件` }
  } catch (e) {
    return { ok: false, detail: String(e?.message || e) }
  }
}

/* ── 重启宿主 ───────────────────────────────────────────────────────── */
export function writeUrlFile(ctx, port) {
  try {
    if (!existsSync(ctx.logsDir)) mkdirSync(ctx.logsDir, { recursive: true })
    writeFileSync(join(ctx.logsDir, 'dsh-web-url.txt'), `http://127.0.0.1:${port}\r\n`, 'utf8')
    return true
  } catch { return false }
}

export async function killHost(ctx) {
  if (!ctx.processName) return { ok: true, detail: '没有进程名，跳过' }
  const procs = await getHostProcesses(ctx)
  if (!procs.length) return { ok: true, killed: 0, detail: '本来就没在跑' }
  await run('taskkill.exe', ['/IM', `${ctx.processName}.exe`, '/T', '/F'], { timeout: 30_000 })
  for (let i = 0; i < 30; i++) {
    await sleep(1000)
    const left = await getHostProcesses(ctx)
    if (!left.length) return { ok: true, killed: procs.length, detail: `已结束 ${procs.length} 个进程` }
  }
  return { ok: false, killed: procs.length, detail: '进程 30 秒还没退干净' }
}

export async function restartHost(ctx, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 180_000
  if (!ctx.appExe || !existsSync(ctx.appExe)) {
    return { ok: false, detail: `找不到 DSH 可执行文件：${ctx.appExe || '（自动发现失败）'}` }
  }
  const k = await killHost(ctx)
  if (!k.ok) return { ok: false, detail: `停不掉旧进程：${k.detail}` }
  await sleep(800)
  let pid
  try {
    pid = launchDetached(ctx.appExe, ctx.launchArgs || [], { cwd: ctx.appRoot, env: ctx.launchEnv })
  } catch (e) {
    return { ok: false, detail: `启动失败：${String(e?.message || e)}` }
  }
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    await sleep(2000)
    const host = await probeHost(ctx)
    if (host.livePort) {
      writeUrlFile(ctx, host.livePort)
      return {
        ok: true,
        pid,
        port: host.livePort,
        seconds: Math.round((Date.now() - started) / 1000),
        detail: `新端口 ${host.livePort}，${host.http.detail}（${Math.round((Date.now() - started) / 1000)}s）`,
      }
    }
  }
  return { ok: false, pid, detail: `${Math.round(timeoutMs / 1000)} 秒内没等到端口` }
}

/* ── 桥接端口同步 ───────────────────────────────────────────────────── */
export async function syncBridge(ctx, livePort, opts = {}) {
  if (!ctx.bridgeHome || !livePort) return { ok: false, detail: '没有桥接目录或端口，跳过' }
  const cfgPath = join(ctx.bridgeHome, 'config.json')
  const cfg = readJsonSafe(cfgPath)
  if (!cfg) return { ok: false, detail: `读不了 ${cfgPath}` }
  const want = `http://127.0.0.1:${livePort}`
  const old = String(cfg?.dsh?.baseUrl || '')
  if (old === want) return { ok: true, changed: false, detail: `桥接已经指向 ${want}` }
  try {
    cfg.dsh = { ...(cfg.dsh || {}), baseUrl: want }
    // 必须 UTF-8 无 BOM：桥接的 sync-dsh-baseurl.mjs 读不动带 BOM 的文件
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8')
  } catch (e) {
    return { ok: false, detail: `写桥接配置失败：${String(e?.message || e)}` }
  }
  if (!opts.restartBridge) return { ok: true, changed: true, detail: `已改 ${old || '(空)'} -> ${want}（桥接需自行重启）` }

  // 让桥接重启：杀掉监听 3100 的进程，守护任务会在 60 秒内拉起
  const raw = await psJson(
    `@(Get-NetTCPConnection -State Listen -LocalPort ${ctx.bridgePort} -ErrorAction SilentlyContinue | Select-Object OwningProcess) | ConvertTo-Json -Compress`,
    { timeout: 15_000 },
  )
  const pids = [...new Set(toArray(raw).filter(Boolean).map((r) => Number(r.OwningProcess)).filter((n) => n > 0))]
  for (const pid of pids) await run('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { timeout: 20_000 })

  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    await sleep(3000)
    const st = await getBridgeStatus(ctx)
    if (st.probed && st.ok && st.dshReady) {
      return { ok: true, changed: true, detail: `已改 ${old || '(空)'} -> ${want}，桥接已重启并就绪` }
    }
  }
  return { ok: false, changed: true, detail: `已改 ${old || '(空)'} -> ${want}，但桥接 90 秒内没就绪` }
}

/* ── 决策树 ─────────────────────────────────────────────────────────── */
export async function repair(ctx, opts = {}) {
  const restartAllowed = !!opts.restart
  return withLock(ctx, async () => {
    const steps = []
    const push = (step, ok, changed, detail) => {
      steps.push({ step, ok, changed, detail })
      if (opts.onStep) try { opts.onStep(steps[steps.length - 1]) } catch { /* ignore */ }
    }

    let diag = await collectChecks(ctx)
    const before = { overall: diag.overall, usable: diag.usable, fails: diag.fails.map((f) => f.id) }

    if (opts.dryRun) {
      const plan = []
      if (diag.versions.drift.length) plan.push('versions')
      if (diag.versions.moduleProblems.length || diag.versions.drift.length) plan.push('install')
      if (diag.fails.some((f) => f.id === 'profile.package' || f.id === 'profile.patch')) plan.push('restore')
      if (!diag.usable || diag.fails.some((f) => ['host.process', 'host.port', 'host.http', 'bridge.ready', 'bridge.baseUrl'].includes(f.id))) {
        plan.push(restartAllowed ? 'restart' : 'restart（需要外部启动器；DSH 内不能自杀）')
      }
      if (diag.fails.some((f) => f.id === 'bridge.baseUrl')) plan.push('bridge')
      return { ok: true, dryRun: true, before, diag, plan, steps: [{ step: 'plan', ok: true, changed: false, detail: plan.join(' → ') || '没什么要修的' }] }
    }

    const snap = takeSnapshot(ctx, 'before-repair')
    push('snapshot', snap.ok, snap.ok, snap.ok ? snap.dir : `快照失败：${snap.detail}`)

    /* 1. 版本 / 依赖 */
    if (diag.versions.drift.length && diag.versions.core.ok) {
      const r = fixVersions(ctx, diag.versions)
      push('versions', r.ok, r.changed.length > 0, r.detail)
    }
    if (diag.versions.drift.length || diag.versions.moduleProblems.length) {
      const r = await runInstall(ctx)
      push('install', r.ok, r.ok, r.detail)
    }

    /* 2. 配置坏了 → 从快照恢复 */
    if (diag.fails.some((f) => f.id === 'profile.package' || f.id === 'profile.patch')) {
      const snapForRestore = diag.snapshots.find((s) => s.hasPkg && s.hasPatch) || diag.snapshots.find((s) => s.hasPkg)
      const r = restoreConfigs(ctx, snapForRestore)
      push('restore', r.ok, r.ok, r.detail)
      if (r.ok) {
        const inst = await runInstall(ctx)
        push('install(恢复后)', inst.ok, inst.ok, inst.detail)
      }
    }

    /* 3. 重启（只有外部启动器能做） */
    const unusable = !diag.usable || diag.fails.some((f) => ['host.process', 'host.port', 'host.http', 'bridge.ready'].includes(f.id))
    if (unusable && restartAllowed) {
      const r = await restartHost(ctx)
      push('restart', r.ok, r.ok, r.detail)
      diag = await collectChecks(ctx)
      if (!diag.usable) {
        const good = diag.snapshots.find((s) => s.hasPkg && s.hasPatch) || diag.snapshots.find((s) => s.hasPkg)
        if (good) {
          const rr = restoreConfigs(ctx, good)
          push('rollback(config)', rr.ok, rr.ok, rr.detail)
          const r2 = await restartHost(ctx)
          push('restart(回滚后)', r2.ok, r2.ok, r2.detail)
        }
      }
    } else if (unusable && !restartAllowed) {
      push('restart', false, false, '跳过了重启：在 DSH 内部重启会掐断当前会话，请用 repair.cmd / 看护任务')
    }

    /* 4. 桥接端口 */
    diag = await collectChecks(ctx)
    const livePort = diag.host.livePort
    const bridgeMismatch = diag.fails.some((f) => f.id === 'bridge.baseUrl') ||
      (diag.bridge.probed && diag.bridge.ok && !diag.bridge.dshReady && livePort)
    if (bridgeMismatch && livePort) {
      const r = await syncBridge(ctx, livePort, { restartBridge: opts.restartBridge !== false })
      push('bridge', r.ok, r.changed !== false, r.detail)
    }

    /* 5. 复诊 */
    const after = await collectChecks(ctx)
    const ok = after.overall === 'healthy'
    return {
      ok,
      before,
      after: { overall: after.overall, usable: after.usable, fails: after.fails.map((f) => f.id) },
      summary: `${summarizeDiag({ ...after })}；修前 ${before.fails.length} 个故障 → 修后 ${after.fails.length} 个`,
      steps,
      diag: after,
    }
  })
}

/** 看护模式：不重启，只修能修的，适合每 10 分钟跑一次。 */
export async function guard(ctx) {
  const diag = await collectChecks(ctx)
  const acted = []
  if (diag.versions.drift.length && diag.versions.core.ok) {
    return withLock(ctx, async () => {
      const snap = takeSnapshot(ctx, 'guard')
      acted.push(`snapshot ${snap.ok ? 'ok' : 'fail'}`)
      const r = fixVersions(ctx, diag.versions)
      acted.push(`versions ${r.ok ? 'ok' : 'fail'}: ${r.detail}`)
      const inst = await runInstall(ctx)
      acted.push(`install ${inst.ok ? 'ok' : 'fail'}: ${inst.detail}`)
      const after = await collectChecks(ctx)
      return { ok: after.versions.drift.length === 0, acted, diag }
    })
  }
  return { ok: diag.overall !== 'broken', acted, diag }
}

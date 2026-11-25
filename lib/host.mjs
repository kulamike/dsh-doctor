// 探测层：读系统状态。全部只读、全部有超时。

import { existsSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { psJson, ps, toArray, sleep } from './sys.mjs'
import { readJsonSafe } from './context.mjs'
import { readAsarPackage, readCoreVersion } from './asar.mjs'

export async function getHostProcesses(ctx) {
  const name = String(ctx.processName).replace(/'/g, "''")
  // 用 CIM 而不是 Get-Process：要拿 CommandLine 才能把 Electron 的渲染/GPU 子进程和真正的主进程分开
  const raw = await psJson(
    `@(Get-CimInstance Win32_Process -Filter "Name='${name}.exe'" | Select-Object ProcessId, ParentProcessId, CommandLine) | ConvertTo-Json -Compress`,
    { timeout: 20_000 },
  )
  return toArray(raw).filter(Boolean).map((p) => {
    const cmd = String(p.CommandLine || '')
    let kind = 'main'
    const m = cmd.match(/--type=([\w-]+)/)
    if (m) kind = m[1]
    else if (/dsh-desktop-host/.test(cmd)) kind = 'host'
    return { pid: Number(p.ProcessId), parentPid: Number(p.ParentProcessId), commandLine: cmd, kind }
  })
}

export async function getListeningPorts(ctx, pids) {
  if (!pids?.length) return []
  const list = pids.join(',')
  const raw = await psJson(
    `@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { @(${list}) -contains $_.OwningProcess } | Select-Object LocalPort, OwningProcess) | ConvertTo-Json -Compress`,
    { timeout: 15_000 },
  )
  return toArray(raw).filter(Boolean).map((r) => ({ port: Number(r.LocalPort), pid: Number(r.OwningProcess) }))
}

/** HTTP 探针：401 也算活着（服务在跑，只是没给 token）。 */
export async function probeHttp(port, timeoutMs = 6000) {
  if (!port) return { alive: false, status: 0, detail: '没有端口' }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, { signal: AbortSignal.timeout(timeoutMs) })
    try { await res.body?.cancel() } catch { /* ignore */ }
    return { alive: true, status: res.status, detail: `HTTP ${res.status}` }
  } catch (e) {
    // fetch 抛错也可能是「连上了但回了怪东西」；再试一次根路径，仍失败才算死
    try {
      const res2 = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(timeoutMs) })
      try { await res2.body?.cancel() } catch { /* ignore */ }
      return { alive: true, status: res2.status, detail: `根路径 HTTP ${res2.status}` }
    } catch {
      return { alive: false, status: 0, detail: String(e?.cause?.code || e?.message || e) }
    }
  }
}

export async function probeHost(ctx) {
  const procs = await getHostProcesses(ctx)
  const ports = await getListeningPorts(ctx, procs.map((p) => p.pid))
  const uniq = [...new Set(ports.map((p) => p.port))].sort((a, b) => a - b)
  const hostPids = [...new Set(ports.map((p) => p.pid))]
  let livePort = 0
  let http = { alive: false, status: 0, detail: '没有端口' }
  for (const port of uniq) {
    http = await probeHttp(port)
    if (http.alive) { livePort = port; break }
  }
  return { procs, ports: uniq, hostPids, livePort, http }
}

export function getBridgeStatus(ctx) {
  return (async () => {
    if (!ctx.bridgeHome) return { probed: false, detail: '没找到 qq-bridge' }
    const tokenFile = join(ctx.bridgeHome, 'state', 'console-token')
    let token = ''
    try { token = readFileSync(tokenFile, 'utf8').trim() } catch { /* ignore */ }
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.bridgePort}/api/status`, {
        headers: token ? { 'x-console-token': token } : {},
        signal: AbortSignal.timeout(8000),
      })
      const body = await res.json().catch(() => null)
      const cfg = readJsonSafe(join(ctx.bridgeHome, 'config.json')) || {}
      const baseUrl = String(cfg?.dsh?.baseUrl || '')
      let basePort = 0
      try { basePort = Number(new URL(baseUrl).port) } catch { /* ignore */ }
      return {
        probed: true,
        ok: res.status === 200,
        dshReady: !!body?.dshReady,
        baseUrl,
        basePort,
        detail: `HTTP ${res.status} dshReady=${body?.dshReady} baseUrl=${baseUrl || '未配置'}`,
      }
    } catch (e) {
      return { probed: true, ok: false, dshReady: false, baseUrl: '', basePort: 0, detail: String(e?.cause?.code || e?.message || e) }
    }
  })()
}

export function readTail(file, maxBytes = 200_000) {
  try {
    const st = statSync(file)
    const size = st.size
    const start = Math.max(0, size - maxBytes)
    const fd = openSync(file, 'r')
    try {
      const buf = Buffer.alloc(size - start)
      readSync(fd, buf, 0, buf.length, start)
      return buf.toString('utf8')
    } finally { closeSync(fd) }
  } catch { return '' }
}

export function tailLines(text, n = 40) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim() !== '')
  return lines.slice(-n)
}

export async function getDiskInfo(drive = 'C:') {
  const raw = await psJson(
    `@(Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${drive}'" | Select-Object DeviceID, FreeSpace, Size) | ConvertTo-Json -Compress`,
    { timeout: 15_000 },
  )
  const row = toArray(raw).filter(Boolean)[0]
  if (!row) return { ok: false, detail: '读不到磁盘信息' }
  const freeGB = Number(row.FreeSpace) / 1024 ** 3
  const totalGB = Number(row.Size) / 1024 ** 3
  return { ok: true, freeGB: Number(freeGB.toFixed(1)), totalGB: Number(totalGB.toFixed(1)), detail: `${freeGB.toFixed(1)}GB 可用 / ${totalGB.toFixed(0)}GB` }
}

/** 核心版本 + profile 依赖版本 + 模块是否真的落地。 */
export function getVersions(ctx) {
  const profile = readJsonSafe(ctx.profilePkg)
  const core = ctx.coreVersionOverride
    ? { ok: true, version: ctx.coreVersionOverride, from: 'override' }
    : readCoreVersion(ctx.asarPath)
  const deps = []
  for (const [name, version] of Object.entries(profile?.dependencies || {})) {
    if (!name.startsWith('@deepseek-ai/dsh-')) continue
    if (!/^\d/.test(String(version))) continue
    const modPkg = join(ctx.profileModules, name, 'package.json')
    const installed = readJsonSafe(modPkg)
    let installedVersion = installed?.version || ''
    let installedFrom = installedVersion ? 'profile' : ''
    if (!installedVersion) {
      for (const inner of [`node_modules/${name}/package.json`, `dsh/node_modules/${name}/package.json`]) {
        const hit = readAsarPackage(ctx.asarPath, inner)
        if (hit.ok && hit.version) { installedVersion = hit.version; installedFrom = 'asar'; break }
      }
    }
    deps.push({
      name,
      declared: String(version),
      matchesCore: !!core.ok && String(version) === core.version,
      installedVersion,
      installedFrom,
      // 「落地」问的是 node_modules 与 package.json 一致，和核心版本无关：
      // 核心读不到时不能连坐，否则会把装好的 6 个依赖全判成故障。
      installedMatches: !!installedVersion && installedVersion === String(version),
    })
  }
  return {
    core,
    profileOk: !!profile,
    deps,
    drift: deps.filter((d) => core.ok && !d.matchesCore),
    moduleProblems: deps.filter((d) => !d.installedVersion || !d.installedMatches),
  }
}

export function listSnapshots(ctx) {
  const dirs = []
  try {
    for (const e of readdirSync(ctx.snapshotsDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const full = join(ctx.snapshotsDir, e.name)
      let mtime = 0
      try { mtime = statSync(full).mtimeMs } catch { /* ignore */ }
      const hasPkg = existsSync(join(full, 'package.json'))
      const hasPatch = existsSync(join(full, 'cordis.patch.yml'))
      dirs.push({ name: e.name, dir: full, mtime, hasPkg, hasPatch })
    }
  } catch { /* ignore */ }
  return dirs.sort((a, b) => b.mtime - a.mtime)
}

export { sleep }

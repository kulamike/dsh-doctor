// 体检：把系统状态翻译成一串可判定的检查项。只读，不改任何东西。

import { existsSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonSafe } from './context.mjs'
import { probeHost, getBridgeStatus, getVersions, getDiskInfo, readTail, tailLines, listSnapshots } from './host.mjs'

const FATAL_PATTERNS = [
  /ERR_MODULE_NOT_FOUND/,
  /Cannot find module/,
  /Uncaught (Exception|Error)/,
  /FATAL/,
  /EADDRINUSE/,
  /error while loading shared libraries/i,
]

async function loadYaml(ctx) {
  try { return await import('yaml') } catch { /* 插件装在 profile 外面时解析不到 */ }
  try {
    // 从 profile 里借 —— profile 自己装了 yaml
    const { createRequire } = await import('node:module')
    const req = createRequire(join(ctx.profileDir, 'noop.js'))
    return req('yaml')
  } catch { return null }
}

async function parseYamlSafe(file, ctx) {
  const mod = await loadYaml(ctx)
  if (!mod) return { ok: true, skipped: true }
  try {
    mod.parse(readFileSync(file, 'utf8'))
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e?.message || e).split('\n')[0] }
  }
}

const chk = (id, title, status, detail, hint = '', fix = '') => ({ id, title, status, detail, hint, fix })

export async function collectChecks(ctx, opts = {}) {
  const checks = []

  /* ── 1. profile 文件 ─────────────────────────────────────────────── */
  const pkg = readJsonSafe(ctx.profilePkg)
  const pkgExists = existsSync(ctx.profilePkg)
  if (!pkgExists) {
    checks.push(chk('profile.package', 'profile package.json', 'fail',
      `找不到 ${ctx.profilePkg}`,
      'profile 目录不对，或 DSH 从没在这里启动过', 'install'))
  } else if (!pkg) {
    checks.push(chk('profile.package', 'profile package.json', 'fail',
      'package.json 存在但解析失败（JSON 坏了）',
      '可从快照恢复；没有快照就手工修', 'restore'))
  } else {
    checks.push(chk('profile.package', 'profile package.json', 'ok',
      `${Object.keys(pkg.dependencies || {}).length} 个依赖`))
  }

  if (!existsSync(ctx.profilePatch)) {
    checks.push(chk('profile.patch', 'cordis.patch.yml', 'fail',
      `找不到 ${ctx.profilePatch}`, '可从快照恢复', 'restore'))
  } else {
    const st = statSync(ctx.profilePatch)
    if (st.size < 10) {
      checks.push(chk('profile.patch', 'cordis.patch.yml', 'fail', `文件只有 ${st.size} 字节`, '内容被清空了，可从快照恢复', 'restore'))
    } else {
      const y = await parseYamlSafe(ctx.profilePatch, ctx)
      if (!y.ok) {
        checks.push(chk('profile.patch', 'cordis.patch.yml', 'fail',
          `YAML 解析失败：${y.error}`, '插件装载表坏了，DSH 起不来；可从快照恢复', 'restore'))
      } else {
        checks.push(chk('profile.patch', 'cordis.patch.yml', 'ok',
          y.skipped ? `${(st.size / 1024).toFixed(1)}KB（未做 YAML 解析）` : `${(st.size / 1024).toFixed(1)}KB，语法正常`))
      }
    }
  }

  /* ── 2. 版本 ─────────────────────────────────────────────────────── */
  const v = getVersions(ctx)
  if (!v.core.ok) {
    // 读不到核心版本不等于 DSH 坏了（插件在宿主里跑时路径推导可能受限）；
    // 它会影响「版本对齐」这项的判断，所以给警告而不是故障。
    checks.push(chk('core.version', '核心版本', 'warn',
      `读不到 app.asar 里的版本：${v.core.error}`,
      '版本对齐这项会不准；用 doctor.cmd / node bin/cli.mjs status 复核', ''))
  } else {
    checks.push(chk('core.version', '核心版本', 'ok', `${v.core.version}（来源 ${v.core.from}）`))
  }
  if (v.drift.length) {
    const rows = v.drift.map((d) => `${d.name.replace('@deepseek-ai/', '')}=${d.declared}`).join('，')
    checks.push(chk('deps.version', '依赖版本对齐', 'fail',
      `与核心 ${v.core.version} 不一致 ${v.drift.length} 个：${rows}`,
      '装插件时最容易踩：整批装成别的版本后 DSH 进程能起但插件对不上', 'versions'))
  } else {
    checks.push(chk('deps.version', '依赖版本对齐', 'ok', `${v.deps.length} 个依赖都与核心一致`))
  }
  if (v.moduleProblems.length) {
    const rows = v.moduleProblems
      .map((d) => `${d.name.replace('@deepseek-ai/', '')}（装的 ${d.installedVersion || '缺失'}，声明 ${d.declared}）`)
      .join('，')
    checks.push(chk('deps.modules', '依赖已落地', 'fail',
      `node_modules 与 package.json 对不上 ${v.moduleProblems.length} 个：${rows}`,
      'package.json 写对了但没重装，重启也白搭', 'install'))
  } else {
    checks.push(chk('deps.modules', '依赖已落地', 'ok', `node_modules 与声明的 ${v.deps.length} 个一致`))
  }

  /* ── 3. 宿主进程 / 端口 / HTTP ───────────────────────────────────── */
  const host = await probeHost(ctx)
  const electronKids = host.procs.filter((p) => p.kind !== 'main' && p.kind !== 'host').length
  if (host.procs.length === 0) {
    checks.push(chk('host.process', 'DSH 进程', 'fail', '没在跑', '双击 repair.cmd 或让看护任务拉起', 'restart'))
  } else if (host.hostPids.length > 1) {
    checks.push(chk('host.process', 'DSH 进程', 'warn',
      `有 ${host.hostPids.length} 个进程在听端口（${host.ports.join(', ')}）`, '多实例会抢端口/抢配置', ''))
  } else {
    const mainPid = host.hostPids[0] || host.procs.find((p) => p.kind === 'host')?.pid || host.procs[0].pid
    checks.push(chk('host.process', 'DSH 进程', 'ok',
      `pid ${mainPid}${electronKids ? `（另有 ${electronKids} 个 Electron 子进程）` : ''}`))
  }
  if (host.procs.length && host.ports.length === 0) {
    checks.push(chk('host.port', '监听端口', 'fail', '进程在，但一个端口都没开', '多半卡在启动/插件加载，重启', 'restart'))
  } else if (host.ports.length) {
    checks.push(chk('host.port', '监听端口', 'ok', host.ports.join(', ')))
  }
  if (host.procs.length) {
    checks.push(chk('host.http', 'HTTP 可访问', host.http.alive ? 'ok' : 'fail',
      `${host.http.detail}${host.livePort ? `（端口 ${host.livePort}）` : ''}`,
      host.http.alive ? '' : '端口在但不回 HTTP，等于用不了；重启', 'restart'))
  }

  /* ── 4. 桥接（她能不能收到消息）──────────────────────────────────── */
  const bridge = await getBridgeStatus(ctx)
  if (!bridge.probed) {
    checks.push(chk('bridge.ready', '桥接', 'warn', bridge.detail))
  } else if (!bridge.ok) {
    checks.push(chk('bridge.ready', '桥接', 'warn', bridge.detail, '桥接本身没起来，QQ 侧会静默', ''))
  } else {
    checks.push(chk('bridge.ready', '桥接 → DSH', bridge.dshReady ? 'ok' : 'fail',
      bridge.detail,
      bridge.dshReady ? '' : '进程在、端口通也可能不能用：这是最接近「她真能说话」的判据', 'restart'))
    if (bridge.basePort && host.livePort && bridge.basePort !== host.livePort) {
      checks.push(chk('bridge.baseUrl', '桥接指向的端口', 'fail',
        `桥接写的是 ${bridge.basePort}，DSH 实际在 ${host.livePort}`,
        'DSH 换端口了但桥接没跟上 → 她收不到也发不出', 'bridge'))
    } else if (bridge.basePort) {
      checks.push(chk('bridge.baseUrl', '桥接指向的端口', 'ok', `都指向 ${bridge.basePort}`))
    }
  }

  /* ── 5. 日志 / 磁盘 / 快照 ───────────────────────────────────────── */
  const errLog = join(ctx.logsDir, 'dsh-web.err.log')
  if (existsSync(errLog)) {
    const text = readTail(errLog, 120_000)
    const hits = []
    for (const line of tailLines(text, 200)) {
      if (FATAL_PATTERNS.some((re) => re.test(line))) hits.push(line.trim().slice(0, 160))
    }
    if (hits.length) {
      checks.push(chk('logs.err', '启动错误日志', 'warn', hits.slice(-3).join(' ｜ '), '看 dsh__logs which=err 取全文', ''))
    } else {
      checks.push(chk('logs.err', '启动错误日志', 'ok', '近期没有致命错误'))
    }
  }

  const disk = await getDiskInfo('C:')
  if (disk.ok) {
    const status = disk.freeGB < 2 ? 'fail' : disk.freeGB < 6 ? 'warn' : 'ok'
    checks.push(chk('disk.free', 'C 盘可用空间', status, disk.detail, status === 'ok' ? '' : '会话/模型文件写不下会直接崩', ''))
  }

  const snaps = listSnapshots(ctx)
  if (snaps.length === 0) {
    checks.push(chk('snapshot.recent', '配置快照', 'warn', '一个快照都没有', '第一次修复会先做一份；也可以手动 snapshot', ''))
  } else {
    const ageH = (Date.now() - snaps[0].mtime) / 3600_000
    checks.push(chk('snapshot.recent', '配置快照', 'ok',
      `${snaps.length} 份，最近一份 ${ageH < 48 ? ageH.toFixed(1) + ' 小时前' : (ageH / 24).toFixed(1) + ' 天前'}`))
  }

  /* ── 汇总 ───────────────────────────────────────────────────────── */
  const fails = checks.filter((c) => c.status === 'fail')
  const warns = checks.filter((c) => c.status === 'warn')
  const overall = fails.length ? 'broken' : warns.length ? 'degraded' : 'healthy'
  const usable = host.procs.length > 0 && host.http.alive && (!bridge.probed || bridge.dshReady)
  return {
    checks,
    fails,
    warns,
    overall,
    usable,
    host,
    bridge,
    versions: v,
    snapshots: snaps,
  }
}

export function summarizeDiag(diag) {
  const label = diag.overall === 'healthy' ? '健康' : diag.overall === 'degraded' ? '能跑但有问题' : '坏了'
  return `${label}（${diag.fails.length} 个故障 / ${diag.warns.length} 个警告 / 可用=${diag.usable ? '是' : '否'}）`
}

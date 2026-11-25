#!/usr/bin/env node
// 独立运行的入口：不需要 DSH 活着，只需要 node。
//   node bin/cli.mjs status            体检（只读）
//   node bin/cli.mjs repair --apply    修复；加 --restart 才重启 DSH
//   node bin/cli.mjs snapshot          存一份 profile 配置快照
//   node bin/cli.mjs rollback          用最近快照恢复配置（不重启）
//   node bin/cli.mjs logs --which err  看日志尾巴
//   node bin/cli.mjs selftest          跑故障注入自测

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveContext } from '../lib/context.mjs'
import { collectChecks, summarizeDiag } from '../lib/checks.mjs'
import { repair, takeSnapshot, restoreConfigs, guard } from '../lib/repair.mjs'
import { checkSelfUpdate } from '../lib/selfupdate.mjs'
import { readTail, tailLines, listSnapshots } from '../lib/host.mjs'
import { renderStatus, renderRepair, renderLogs } from '../lib/report.mjs'

function parseArgs(argv) {
  const out = { _: [], flags: {} }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) { out.flags[key] = next; i++ } else { out.flags[key] = true }
    } else out._.push(a)
  }
  return out
}

function ctxFromFlags(flags) {
  const overrides = {}
  for (const k of ['profileDir', 'appExe', 'dshHome', 'bridgeHome', 'qqAgentDir', 'nodeExe', 'processName']) {
    if (typeof flags[k] === 'string') overrides[k] = flags[k]
  }
  if (flags.bridgePort) overrides.bridgePort = Number(flags.bridgePort)
  if (typeof flags.launchExe === 'string') overrides.appExe = flags.launchExe
  return resolveContext(overrides)
}

const LOG_FILES = {
  err: 'dsh-web.err.log',
  out: 'dsh-web.out.log',
  capture: 'dsh-capture.log',
  rescue: 'dsh-rescue.log',
  bridge: null, // 桥接日志在 bridgeHome/state 下
}

async function cmdStatus(ctx, flags) {
  const diag = await collectChecks(ctx)
  if (flags.json) { process.stdout.write(JSON.stringify(diag, null, 2)); return diag.overall === 'healthy' ? 0 : 1 }
  console.log(renderStatus(diag, { verbose: !!flags.verbose }))
  return diag.overall === 'healthy' ? 0 : 1
}

async function cmdRepair(ctx, flags) {
  const apply = !!flags.apply || !!flags.yes
  const result = await repair(ctx, {
    dryRun: !apply,
    restart: !!flags.restart,
    restartBridge: flags['no-bridge'] ? false : true,
    onStep: (s) => { if (!flags.json) console.log(`  ${s.ok ? '✅' : '❌'} ${s.step}：${s.detail}`) },
  })
  if (flags.json) { process.stdout.write(JSON.stringify(result, null, 2)); return result.ok ? 0 : 1 }
  // onStep 已经实时打过步骤，这里只补结论
  if (apply) {
    console.log('')
    console.log(result.summary || (result.ok ? '已修好' : '还有问题'))
    if (!result.ok) console.log(renderRepair(result))
  } else {
    console.log(renderRepair(result))
  }
  return result.ok ? 0 : 1
}

async function cmdGuard(ctx) {
  const r = await guard(ctx)
  console.log(`${summarizeDiag(r.diag)}${r.acted.length ? ' ｜ ' + r.acted.join(' ｜ ') : ''}`)
  return r.ok ? 0 : 1
}

function cmdSnapshot(ctx) {
  const r = takeSnapshot(ctx, 'cli')
  console.log(r.ok ? `快照：${r.dir}` : `快照失败：${r.detail}`)
  return r.ok ? 0 : 1
}

function cmdRollback(ctx, flags) {
  const snaps = listSnapshots(ctx)
  if (!snaps.length) { console.log('没有快照可回滚'); return 1 }
  let target = snaps[0]
  if (typeof flags.snapshot === 'string') {
    target = snaps.find((s) => s.name === flags.snapshot || s.dir === flags.snapshot) || target
  }
  const r = restoreConfigs(ctx, target)
  console.log(`${r.ok ? '✅' : '❌'} ${r.detail}`)
  if (r.ok) console.log(`回滚的是 ${target.name}；要让改动生效需要重启 DSH（repair.cmd 或重启桌面程序）`)
  return r.ok ? 0 : 1
}

function cmdLogs(ctx, flags) {
  const which = String(flags.which || 'err')
  const n = Number(flags.lines || 40)
  let file = LOG_FILES[which]
  if (which === 'bridge' && ctx.bridgeHome) file = join(ctx.bridgeHome, 'state', 'bridge.log')
  if (!file) { console.log(`不认识的日志：${which}（可选 err/out/capture/rescue/bridge）`); return 2 }
  const full = join(ctx.logsDir, file)
  if (!existsSync(full)) { console.log(`没有这个文件：${full}`); return 1 }
  console.log(renderLogs(which, tailLines(readTail(full, 200_000), n)))
  return 0
}

async function cmdSelfupdate(ctx, flags) {
  const r = await checkSelfUpdate(ctx, { apply: !!flags.apply })
  console.log(`核心版本    : ${r.coreVersion ?? '读不到'}（上次记录 ${r.lastCoreVersion || '无'}）`)
  console.log(`版本变化    : ${r.coreChanged ? '是' : '否'}${r.firstRun ? '（首次记录）' : ''}`)
  console.log(`自更新      : ${r.enabled ? '启用' : '禁用'}`)
  console.log(`仓库        : ${r.repo?.isGit ? `${r.repo.remote} @ ${r.repo.branch} ${r.repo.head}${r.repo.dirty ? '（有未提交改动）' : ''}` : '不是 git 仓库'}`)
  console.log(`结果        : ${r.note}`)
  return r.coreChanged && !r.updated && flags.apply ? 1 : 0
}

async function cmdSelftest() {  const mod = await import('../test/run.mjs')
  const ok = await mod.runSelfTest()
  return ok ? 0 : 1
}

function usage() {
  console.log('用法: node bin/cli.mjs <status|repair|guard|snapshot|rollback|logs|selftest> [选项]')
  console.log('  status   [--json] [--verbose]')
  console.log('  repair   [--apply] [--restart] [--json] [--no-bridge]')
  console.log('  snapshot | rollback [--snapshot 名字]')
  console.log('  selfupdate [--apply]   检查 DSH 版本变化并只更新本插件')
  console.log('  logs     [--which err|out|capture|rescue|bridge] [--lines 40]')
}

async function main() {
  const { _, flags } = parseArgs(process.argv.slice(2))
  const cmd = _[0] || 'status'
  const ctx = ctxFromFlags(flags)
  try {
    switch (cmd) {
      case 'status': return await cmdStatus(ctx, flags)
      case 'repair': return await cmdRepair(ctx, flags)
      case 'guard': return await cmdGuard(ctx)
      case 'snapshot': return cmdSnapshot(ctx)
      case 'rollback': return cmdRollback(ctx, flags)
      case 'logs': return cmdLogs(ctx, flags)
      case 'selfupdate': return await cmdSelfupdate(ctx, flags)
      case 'selftest': return await cmdSelftest()
      case 'help': case '-h': case '--help': usage(); return 0
      default: usage(); return 2
    }
  } catch (e) {
    console.error(`出错了：${e?.stack || e}`)
    return 1
  }
}

process.exitCode = await main()

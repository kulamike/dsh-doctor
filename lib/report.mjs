// 给人看的渲染。终端和 DSH 工具共用同一套文字。

const MARK = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL' }

export function renderStatus(diag, opts = {}) {
  const lines = []
  const head = diag.overall === 'healthy' ? '✅ 健康' : diag.overall === 'degraded' ? '⚠️ 能跑但有问题' : '❌ 坏了'
  lines.push(`DSH 体检 ${new Date().toLocaleString('zh-CN', { hour12: false })}`)
  lines.push(`结论      : ${head}    可用=${diag.usable ? '是' : '否'}`)
  const h = diag.host
  lines.push(`进程/端口 : ${h.procs.length} 个进程 ｜ 端口 ${h.ports.join(', ') || '无'} ｜ ${h.http.detail}`)
  const v = diag.versions
  lines.push(`核心版本  : ${v.core.ok ? `${v.core.version}（${v.core.from}）` : '读不到'} ｜ 依赖 ${v.deps.length} 个，漂移 ${v.drift.length} 个`)
  if (diag.bridge.probed) lines.push(`桥接      : ${diag.bridge.detail}`)
  lines.push('')
  const order = { fail: 0, warn: 1, ok: 2 }
  for (const c of [...diag.checks].sort((a, b) => order[a.status] - order[b.status])) {
    if (!opts.verbose && c.status === 'ok') continue
    lines.push(`${MARK[c.status]} ${c.title}：${c.detail}`)
    if (c.hint) lines.push(`      → ${c.hint}`)
  }
  const okCount = diag.checks.filter((c) => c.status === 'ok').length
  lines.push('')
  lines.push(`${okCount} 项正常 / ${diag.warns.length} 项警告 / ${diag.fails.length} 项故障`)
  if (diag.fails.length) lines.push('要修就运行：repair.cmd（或 node bin/cli.mjs repair --apply --restart）')
  return lines.join('\n')
}

export function renderRepair(result) {
  const lines = []
  if (result.busy) return `没跑：${result.detail}`
  if (result.dryRun) {
    lines.push('修复计划（什么都没改）：')
    const plan = result.plan || []
    lines.push(plan.length ? plan.map((p, i) => `  ${i + 1}. ${p}`).join('\n') : '  没什么要修的')
    lines.push('')
    lines.push('真修：repair.cmd，或 node bin/cli.mjs repair --apply --restart')
    return lines.join('\n')
  }
  lines.push('修复过程：')
  for (const s of result.steps) {
    lines.push(`  ${s.ok ? '✅' : '❌'} ${s.step}${s.changed ? '（有改动）' : ''}：${s.detail}`)
  }
  lines.push('')
  lines.push(result.summary || (result.ok ? '已修好' : '还有问题没解决'))
  if (!result.ok && result.after?.fails?.length) {
    lines.push(`仍未解决：${result.after.fails.join(', ')}`)
    lines.push('线上还有问题的话，把这份输出发我；profile 快照在 qq-agent\\snapshots 里。')
  }
  return lines.join('\n')
}

export function renderLogs(which, lines) {
  return `===== ${which}（最后 ${lines.length} 行）=====\n${lines.join('\n') || '（空）'}`
}

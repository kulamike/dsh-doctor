// 给人看的渲染。终端和 DSH 工具共用同一套文字。
// 只用字符串拼接 + 手写的显示宽度折算：不引任何依赖，也不求终端支持颜色。

const ICON = { ok: '✅', warn: '⚠️', fail: '❌' }
const WIDTH = 64

/** 检查项按 id 前缀分组，顺序就是体检报告里的顺序。 */
const GROUPS = [
  { title: '配置文件', match: (id) => id.startsWith('profile.') },
  { title: '版本与依赖', match: (id) => id === 'core.version' || id.startsWith('deps.') },
  { title: '进程 · 端口 · HTTP', match: (id) => id.startsWith('host.') },
  { title: '桥接（她能不能说话）', match: (id) => id.startsWith('bridge.') },
  { title: '日志 · 磁盘 · 快照', match: (id) => id.startsWith('logs.') || id.startsWith('disk.') || id.startsWith('snapshot.') },
]

/* ── 等宽对齐：CJK / emoji 记 2 列 ──────────────────────────────────── */
function isWide(cp) {
  return (cp >= 0x1100 && cp <= 0x115f)
    || (cp >= 0x2e80 && cp <= 0x303e)
    || (cp >= 0x3041 && cp <= 0x33ff)
    || (cp >= 0x3400 && cp <= 0x4dbf)
    || (cp >= 0x4e00 && cp <= 0x9fff)
    || (cp >= 0xa000 && cp <= 0xa4cf)
    || (cp >= 0xac00 && cp <= 0xd7a3)
    || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xfe30 && cp <= 0xfe6f)
    || (cp >= 0xff00 && cp <= 0xff60)
    || (cp >= 0xffe0 && cp <= 0xffe6)
    || (cp >= 0x1f000 && cp <= 0x1faff)
    || cp === 0x2705 || cp === 0x274c || cp === 0x26a0
}

function dw(text) {
  let n = 0
  for (const ch of String(text ?? '')) {
    const cp = ch.codePointAt(0)
    if (cp === 0xfe0f || cp === 0xfe0e || cp === 0x200d) continue // 变体选择符 / ZWJ 不占位
    if (cp < 0x20) continue
    n += isWide(cp) ? 2 : 1
  }
  return n
}

function pad(text, n) {
  const s = String(text ?? '')
  const gap = n - dw(s)
  return gap > 0 ? s + ' '.repeat(gap) : s
}

function rule(ch = '─') {
  return ch.repeat(WIDTH)
}

function section(title) {
  const head = `── ${title} `
  return head + '─'.repeat(Math.max(2, WIDTH - dw(head)))
}

function kv(rows, keyW = 6) {
  return rows.map(([k, v]) => `  ${pad(k, keyW)}${v}`).join('\n')
}

function verdictOf(overall) {
  if (overall === 'healthy') return '✅ 健康'
  if (overall === 'degraded') return '⚠️ 有问题'
  if (overall === 'broken') return '❌ 坏了'
  return '❔ 未知'
}

function failsOf(obj) {
  return Array.isArray(obj?.fails) ? obj.fails.length : null
}

/* ── 体检报告 ───────────────────────────────────────────────────────── */
export function renderStatus(diag, opts = {}) {
  const d = diag || {}
  const checks = Array.isArray(d.checks) ? d.checks.filter(Boolean) : []
  const fails = Array.isArray(d.fails) ? d.fails : checks.filter((c) => c.status === 'fail')
  const warns = Array.isArray(d.warns) ? d.warns : checks.filter((c) => c.status === 'warn')
  const okCount = checks.filter((c) => c.status === 'ok').length
  const verbose = !!opts.verbose

  const host = d.host || {}
  const procs = Array.isArray(host.procs) ? host.procs : []
  const ports = Array.isArray(host.ports) ? host.ports : []
  const http = host.http || {}
  const versions = d.versions || {}
  const core = versions.core || {}
  const deps = Array.isArray(versions.deps) ? versions.deps : []
  const drift = Array.isArray(versions.drift) ? versions.drift : []
  const bridge = d.bridge || {}
  const usable = d.usable === true

  const out = []
  out.push(`DSH 体检 · ${new Date().toLocaleString('zh-CN', { hour12: false })}`)
  out.push(rule('━'))

  /* 结论块放最上面：一眼先看结论，再看明细 */
  out.push(kv([
    ['结论', `${verdictOf(d.overall)} · ${usable ? '可用' : '不可用'}`],
    ['计数', `${okCount} 项正常 · ${warns.length} 项警告 · ${fails.length} 项故障`],
    ['宿主',
      (procs.length ? `${procs.length} 个进程` : '没在跑')
      + ` ｜ ${ports.length ? '端口 ' + ports.join(', ') : '没有监听端口'}`
      + ` ｜ ${http.detail || 'HTTP 未探测'}`],
    ['版本',
      (core.ok ? `${core.version}（${core.from}）` : '读不到核心版本')
      + ` ｜ 依赖 ${deps.length} 个 · 漂移 ${drift.length} 个`],
    ...(bridge.probed ? [['桥接', bridge.detail || '已探测']] : []),
  ]))

  /* 明细：故障 → 警告 → 正常，按分组切段 */
  const visible = checks.filter((c) => verbose || c.status !== 'ok')
  const titleW = Math.min(20, visible.reduce((m, c) => Math.max(m, dw(c.title || c.id || '')), 0))

  const row = (c) => {
    const icon = ICON[c.status] || '•'
    const title = String(c.title || c.id || '')
    const lines = [`  ${icon}  ${pad(title, titleW)}  ${String(c.detail || '')}`]
    if (c.hint) lines.push(`      → ${c.hint}`)
    return lines
  }

  if (!checks.length) {
    out.push('')
    out.push('  （没有检查项：context 可能没解析出来）')
  } else if (!visible.length) {
    out.push('')
    out.push(`  ${ICON.ok} ${okCount} 项检查全部正常${verbose ? '' : '（加 --verbose 看明细）'}`)
  } else {
    const grouped = new Set()
    for (const g of GROUPS) {
      const rows = visible.filter((c) => g.match(String(c.id || '')))
      if (!rows.length) continue
      rows.forEach((c) => grouped.add(c))
      out.push('')
      out.push(section(g.title))
      for (const c of rows) out.push(...row(c))
    }
    const rest = visible.filter((c) => !grouped.has(c))
    if (rest.length) {
      out.push('')
      out.push(section('其他'))
      for (const c of rest) out.push(...row(c))
    }
  }

  out.push('')
  out.push(rule('━'))
  const hidden = verbose || !visible.length ? 0 : okCount
  if (hidden) out.push(`  另有 ${hidden} 项正常未列出（加 --verbose 看全部 ${checks.length} 项）`)
  if (fails.length) {
    out.push('  要修就跑：repair.cmd（或 node bin\\cli.mjs repair --apply --restart）')
  } else if (warns.length) {
    out.push('  能跑；警告项建议看一眼，需要明细加 --verbose')
  } else if (!hidden) {
    out.push('  没事可做。')
  }
  return out.join('\n')
}

/* ── 修复结果 ───────────────────────────────────────────────────────── */
const STEP_LABEL = {
  snapshot: '配置快照',
  versions: '对齐版本',
  install: '重装依赖',
  restore: '恢复配置',
  restart: '重启 DSH',
  bridge: '同步桥接',
  plan: '计划',
}

function splitStep(step) {
  const raw = String(step || '').trim()
  const key = raw.split(/[（(]/)[0].trim()
  return { key, note: raw.slice(key.length) }
}

function stepLabel(key) {
  return STEP_LABEL[key] || key || '步骤'
}

export function renderRepair(result) {
  const r = result || {}
  if (r.busy) return `没跑：${r.detail || '另一个修复正在跑'}`

  const out = []
  if (r.dryRun) {
    const plan = Array.isArray(r.plan) ? r.plan : []
    out.push('DSH 修复 · 演练（什么都没改）')
    out.push(rule('━'))
    if (r.before) {
      out.push(kv([
        ['现状', verdictOf(r.before.overall) + (r.before.fails ? ` · ${r.before.fails.length} 个故障` : '')],
        ...(plan.length ? [['计划', `${plan.length} 步`]] : []),
      ]))
    }
    out.push('')
    if (plan.length) {
      out.push(section('计划'))
      plan.forEach((p, i) => {
        const { key, note } = splitStep(p)
        out.push(`  ${String(i + 1).padStart(2)}. ${stepLabel(key)}${note}`)
      })
    } else {
      out.push(`  ${ICON.ok} 没什么要修的`)
    }
    out.push('')
    out.push(rule('━'))
    out.push('  真修：repair.cmd，或 node bin\\cli.mjs repair --apply --restart')
    return out.join('\n')
  }

  const steps = (Array.isArray(r.steps) ? r.steps : []).filter(Boolean)
  const ok = r.ok === true
  const okSteps = steps.filter((s) => s.ok).length
  const badSteps = steps.length - okSteps
  const afterFails = Array.isArray(r.after?.fails) ? r.after.fails : []

  out.push('DSH 修复 · 结果')
  out.push(rule('━'))
  out.push(kv([
    ['结论', ok ? '✅ 已修好' : '❌ 还有问题'],
    ...(r.before && r.after
      ? [['对比', `修前 ${verdictOf(r.before.overall)} · ${failsOf(r.before) ?? 0} 个故障`
        + `  →  修后 ${verdictOf(r.after.overall)} · ${failsOf(r.after) ?? 0} 个故障`]]
      : r.summary ? [['摘要', r.summary]] : []),
  ]))
  out.push('')
  out.push(section('步骤'))
  if (!steps.length) out.push('  （没有执行任何步骤）')
  else {
    const labelW = Math.min(12, steps.reduce((m, s) => Math.max(m, dw(stepLabel(splitStep(s.step).key))), 0))
    for (const s of steps) {
      const label = stepLabel(splitStep(s.step).key)
      out.push(`  ${s.ok ? ICON.ok : ICON.fail}  ${pad(label, labelW)}  ${s.detail || ''}${s.changed ? '  · 有改动' : ''}`)
    }
  }
  out.push('')
  out.push(rule('━'))
  out.push(`  ${steps.length} 个步骤 · ${okSteps} 个成功${badSteps ? ` · ${badSteps} 个失败` : ''}`)
  if (!ok && afterFails.length) {
    out.push(`  仍未解决：${afterFails.join('、')}`)
    out.push('  线上还有问题的话，把这份输出发我；profile 快照在 qq-agent\\snapshots 里。')
  }
  return out.join('\n')
}

/* ── 日志尾巴 ───────────────────────────────────────────────────────── */
export function renderLogs(which, lines) {
  const list = Array.isArray(lines) ? lines : []
  return `${section(`${which} · 最后 ${list.length} 行`)}\n${list.join('\n') || '（空）'}`
}

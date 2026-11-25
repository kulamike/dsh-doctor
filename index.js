/**
 * dsh-doctor —— DSH 急救箱。
 *
 * 为什么要它：DSH 会坏，而且坏的样子很骗人——进程起来了、端口新开了、err 日志是空的，
 * 但插件 API 对不上，等于用不了。上次这种事只能靠人手工修。这个插件把「诊断 + 修复」
 * 做成一等公民，并且**修复引擎不依赖 DSH**：lib/ 和 bin/cli.mjs 只用 node 标准库，
 * 所以 DSH 挂了也能从桌面/命令行直接跑（repair.cmd）。
 *
 * 宿主这边只做一件事：把同一套引擎暴露成工具。
 *   dsh__status    体检（只读）
 *   dsh__repair    修复（默认演练；在 DSH 里绝不重启自己）
 *   dsh__snapshot  存 profile 配置快照
 *   dsh__rollback  用快照恢复配置（不重启）
 *   dsh__logs      看日志尾巴
 */

import { resolveContext } from './lib/context.mjs'
import { collectChecks } from './lib/checks.mjs'
import { repair, takeSnapshot, restoreConfigs } from './lib/repair.mjs'
import { checkSelfUpdate, readState, writeState } from './lib/selfupdate.mjs'
import { listSnapshots, readTail, tailLines } from './lib/host.mjs'
import { renderStatus, renderRepair, renderLogs } from './lib/report.mjs'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

export const name = 'dsh-doctor'
export const inject = ['tools']

const textOut = (schema, toText) => ({
  schema,
  render: (_args, value) => [{ type: 'text', text: toText(value) }],
})

export function apply(ctx, rawConfig = {}) {
  const log = (m) => { try { ctx.logger?.info?.(`[dsh-doctor] ${m}`) } catch { /* 没有 logger 就算了 */ } }

  const overrides = {}
  for (const k of ['profileDir', 'appExe', 'dshHome', 'bridgeHome', 'qqAgentDir', 'nodeExe']) {
    if (typeof rawConfig?.[k] === 'string' && rawConfig[k]) overrides[k] = rawConfig[k]
  }
  if (rawConfig?.bridgePort) overrides.bridgePort = Number(rawConfig.bridgePort)
  if (rawConfig?.keepSnapshots) overrides.keepSnapshots = Number(rawConfig.keepSnapshots)

  const base = resolveContext(overrides)
  log(`profile=${base.profileDir} app=${base.appExe || '(没找到)'} node=${base.nodeExe}`)

  // 跟随 DSH 更新：只在「核心版本变了」时动，且只 pull 这个插件自己的仓库。
  // 绝不动 profile 的依赖版本，也不跑 pnpm —— 这条边界是硬约束。
  if (base.selfUpdate?.enabled !== false) {
    checkSelfUpdate(base, { apply: true })
      .then((r) => {
        if (r.coreChanged || r.firstRun) log(`跟随更新：${r.note}`)
      })
      .catch((e) => log(`跟随更新检查失败：${e?.message ?? e}`))
  } else {
    log('跟随更新：已禁用（selfUpdate.enabled=false），只记录版本')
  }

  const register = (def) => {
    try { ctx.tools.register(def) } catch (e) { log(`注册 ${def.name} 失败：${e?.message ?? e}`) }
  }

  register({
    name: 'dsh__selfupdate',
    description: '检查 DSH 核心版本有没有变；变了就只更新这个插件自己（git pull 本插件的仓库）。永远不会修改 DSH 的版本、也不会动 profile 的依赖。默认按配置执行，可传 mode 指定只看/强制拉取。',
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['check', 'apply', 'disable', 'enable'],
          description: 'check=只看不动；apply=允许拉取；disable/enable=改开关（写状态文件，不改配置）',
        },
      },
      additionalProperties: false,
    },
    output: textOut({ type: 'object' }, (v) => v?.text || '（没有结果）'),
    execute: async (args) => {
      const mode = String(args?.mode || 'check')
      if (mode === 'disable' || mode === 'enable') {
        // 持久开关：写进状态文件，重启后依然有效；不碰 bundle 配置
        writeState(base, { selfUpdateDisabled: mode === 'disable' })
        return {
          text: `自更新已${mode === 'enable' ? '启用' : '禁用'}（已写入状态文件，重启后仍有效；配置里的 selfUpdate.enabled 未改动）`,
          ok: true,
        }
      }
      const r = await checkSelfUpdate(base, { apply: mode === 'apply' })
      const lines = [
        `核心版本：${r.coreVersion ?? '读不到'}（上次记录：${r.lastCoreVersion || '无'}）`,
        `仓库：${r.repo?.isGit ? `${r.repo.remote} @ ${r.repo.branch} ${r.repo.head}` : '不是 git 仓库'}`,
        r.coreChanged ? '核心版本变了 → 触发跟随更新' : '核心版本没变',
        r.note,
      ]
      return { text: lines.join('\n'), ok: true, result: r }
    },
  })

  register({
    name: 'dsh__status',
    description: '给 DSH 做一次体检（只读）：进程/端口/HTTP、核心与依赖版本、桥接是否就绪、日志与磁盘。返回按严重程度排序的检查项。DSH 坏掉时用它定位问题。',
    parameters: {
      type: 'object',
      properties: {
        verbose: { type: 'boolean', description: '把正常的项也列出来（默认只列警告和故障）' },
      },
      additionalProperties: false,
    },
    output: textOut({ type: 'object' }, (v) => v?.text || '（没有结果）'),
    execute: async (args) => {
      const diag = await collectChecks(base)
      return { text: renderStatus(diag, { verbose: !!args?.verbose }), overall: diag.overall, usable: diag.usable }
    },
  })

  register({
    name: 'dsh__repair',
    description: '按体检结果修复 DSH：对齐依赖版本、重装 node_modules、从快照恢复坏掉的 profile 配置、同步桥接端口。默认只演练；在 DSH 内部不会重启 DSH（那会掐断当前会话），重启请用桌面上的 repair.cmd。',
    parameters: {
      type: 'object',
      properties: {
        apply: { type: 'boolean', description: 'true = 真的动手；不传只返回计划' },
        restart: { type: 'boolean', description: '在 DSH 内部传 true 会被拒绝：重启只能从外部启动器做' },
      },
      additionalProperties: false,
    },
    output: textOut({ type: 'object' }, (v) => v?.text || '（没有结果）'),
    execute: async (args) => {
      if (args?.restart) {
        return {
          text: '拒绝了：在 DSH 内部重启会立刻掐断这个会话，工具结果也回不来。\n'
            + `正确做法：双击 ${join(base.qqAgentDir, '..', 'plugins-src', 'dsh-doctor', 'repair.cmd')}，`
            + '或运行 `node bin/cli.mjs repair --apply --restart`（在 DSH 外面），'
            + '看护任务 DSH-Rescue-Watchdog 也会在检测到「不可用」时自动重启。',
          refused: true,
        }
      }
      const result = await repair(base, { dryRun: !args?.apply, restart: false, restartBridge: !!args?.apply })
      const text = args?.apply ? renderRepair(result) : `${renderRepair(result)}\n\n--- 修前结论 ---\n${renderStatus(result.diag, {})}`
      return { text, ok: !!result.ok, steps: result.steps }
    },
  })

  register({
    name: 'dsh__snapshot',
    description: '把 profile 的 package.json 与 cordis.patch.yml 存成一份快照（修复前会自动做，手动做也行）。返回快照目录。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: textOut({ type: 'object' }, (v) => v?.text || '（没有结果）'),
    execute: async () => {
      const r = takeSnapshot(base, 'tool')
      return { text: r.ok ? `快照已存：${r.dir}（${r.files.join('、')}）` : `快照失败：${r.detail}`, ok: r.ok, dir: r.dir }
    },
  })

  register({
    name: 'dsh__rollback',
    description: '用最近（或指定）的一份快照恢复 profile 配置。只恢复文件，不重启；重启后生效。',
    parameters: {
      type: 'object',
      properties: { snapshot: { type: 'string', description: '快照目录名；不传用最近一份' } },
      additionalProperties: false,
    },
    output: textOut({ type: 'object' }, (v) => v?.text || '（没有结果）'),
    execute: async (args) => {
      const snaps = listSnapshots(base)
      if (!snaps.length) return { text: '没有快照可回滚', ok: false }
      const target = args?.snapshot
        ? (snaps.find((s) => s.name === args.snapshot || s.dir === args.snapshot) || snaps[0])
        : snaps[0]
      const r = restoreConfigs(base, target)
      return {
        text: r.ok
          ? `已从 ${target.name} 恢复：${r.detail}\n改动要重启 DSH 才生效（` + 'repair.cmd 或桌面程序）。'
          : `回滚失败：${r.detail}`,
        ok: r.ok,
      }
    },
  })

  register({
    name: 'dsh__logs',
    description: '读 DSH 相关日志的最后若干行：启动错误（err）、启动输出（out）、重启捕获（capture）、自救日志（rescue）、桥接（bridge）。',
    parameters: {
      type: 'object',
      properties: {
        which: { type: 'string', enum: ['err', 'out', 'capture', 'rescue', 'bridge'], description: '默认 err' },
        lines: { type: 'number', description: '行数，默认 40，最多 200' },
      },
      additionalProperties: false,
    },
    output: textOut({ type: 'object' }, (v) => v?.text || '（没有结果）'),
    execute: async (args) => {
      const which = String(args?.which || 'err')
      const n = Math.max(1, Math.min(200, Number(args?.lines) || 40))
      const map = {
        err: 'dsh-web.err.log',
        out: 'dsh-web.out.log',
        capture: 'dsh-capture.log',
        rescue: 'dsh-rescue.log',
      }
      const file = which === 'bridge'
        ? (base.bridgeHome ? join(base.bridgeHome, 'state', 'bridge.log') : '')
        : join(base.logsDir, map[which] || map.err)
      if (!file || !existsSync(file)) return { text: `没有这个日志：${which}`, ok: false }
      return { text: renderLogs(which, tailLines(readTail(file, 200_000), n)), ok: true }
    },
  })

  log('已注册 5 个工具（dsh__status / dsh__repair / dsh__snapshot / dsh__rollback / dsh__logs）')
}

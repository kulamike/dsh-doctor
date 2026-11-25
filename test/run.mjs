// 故障注入自测：把各种坏法造出来，看引擎能不能发现并修好。
// 直接跑：node test/run.mjs
// 全程只在临时目录里玩，不碰真实 profile（除了最后那个假宿主，用独立进程名）。

import {
  copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveContext } from '../lib/context.mjs'
import { collectChecks } from '../lib/checks.mjs'
import { repair, syncBridge, restartHost, killHost, takeSnapshot } from '../lib/repair.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const bundleRoot = dirname(here)
const CORE = '0.2.2-rc.5'
const results = []

function check(name, fn) {
  return { name, fn }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}
function record(name, ok, error) {
  results.push({ name, ok, error })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ← ' + error}`)
}

function makeSandbox(label) {
  const root = mkdtempSync(join(tmpdir(), `dsh-doctor-${label}-`))
  const dirs = {
    root,
    profile: join(root, 'profile'),
    qq: join(root, 'qq-agent'),
    bridge: join(root, 'bridge'),
    logs: join(root, 'qq-agent', 'logs'),
    snapshots: join(root, 'qq-agent', 'snapshots'),
  }
  for (const d of [dirs.profile, dirs.qq, dirs.bridge, dirs.logs, dirs.snapshots]) mkdirSync(d, { recursive: true })
  writeFileSync(join(dirs.profile, 'cordis.patch.yml'), '- insert:\n    - id: demo\n      name: demo\n      config: {}\n', 'utf8')
  writeFileSync(join(dirs.bridge, 'config.json'), JSON.stringify({ dsh: { baseUrl: 'http://127.0.0.1:1' }, consolePort: 9 }, null, 2), 'utf8')
  writeFileSync(join(dirs.logs, 'dsh-web.err.log'), '', 'utf8')
  return dirs
}

function writeProfile(dirs, deps) {
  const pkg = { name: 'demo-profile', version: '1.0.0', dependencies: deps }
  writeFileSync(join(dirs.profile, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  for (const [name, version] of Object.entries(deps)) {
    if (!/^\d/.test(String(version))) continue
    const modDir = join(dirs.profile, 'node_modules', ...name.split('/'))
    mkdirSync(modDir, { recursive: true })
    writeFileSync(join(modDir, 'package.json'), JSON.stringify({ name, version }), 'utf8')
  }
}

const REAL_YAML = 'C:\\Users\\Administrator\\.dsh\\profiles\\desktop\\node_modules\\yaml'

/** 把真实 profile 里的 yaml 包借给沙箱，这样 YAML 解析这条路是真跑过的。 */
function provideYaml(dirs) {
  try {
    if (!existsSync(REAL_YAML)) return false
    const dest = join(dirs.profile, 'node_modules', 'yaml')
    mkdirSync(dirname(dest), { recursive: true })
    cpSync(REAL_YAML, dest, { recursive: true })
    return true
  } catch { return false }
}

function baseCtx(dirs, mark) {  if (mark) process.env.DOCTOR_TEST_MARK = mark
  return resolveContext({
    profileDir: dirs.profile,
    dshHome: dirs.root,
    qqAgentDir: dirs.qq,
    bridgeHome: dirs.bridge,
    bridgePort: 9,
    appExe: '',
    processName: 'dsh-doctor-no-such-host',
    nodeExe: process.execPath,
    pnpmCli: join(here, 'fixtures', 'fake-pnpm.mjs'),
    coreVersionOverride: CORE,
    keepSnapshots: 5,
  })
}

/* ── 1. 版本漂移：发现 + 修好 ──────────────────────────────────────── */
const t1 = check('版本漂移被检测并修复（含重装）', async () => {
  const dirs = makeSandbox('drift')
  const mark = join(dirs.root, 'pnpm-marker.log')
  writeProfile(dirs, {
    '@deepseek-ai/dsh-compaction-basic': '0.2.1-alpha.2',
    '@deepseek-ai/dsh-compaction-ok': CORE,
    'some-other-plugin': '1.0.0',
  })
  const ctx = baseCtx(dirs, mark)
  const before = await collectChecks(ctx)
  assert(before.versions.drift.length === 1, `drift 应为 1，实际 ${before.versions.drift.length}`)
  assert(before.fails.some((f) => f.id === 'deps.version'), '应报 deps.version 故障')

  const r = await repair(ctx, { restart: false })
  assert(r.steps.some((s) => s.step === 'versions' && s.ok && s.changed), '应有 versions 步骤且改动')
  assert(r.steps.some((s) => s.step === 'install' && s.ok), '应有 install 步骤且成功')
  const pkg = JSON.parse(readFileSync(ctx.profilePkg, 'utf8'))
  assert(pkg.dependencies['@deepseek-ai/dsh-compaction-basic'] === CORE, '依赖没改成核心版本')
  assert(pkg.dependencies['some-other-plugin'] === '1.0.0', '不该动非 dsh 依赖')
  assert(existsSync(mark), '没调用 pnpm install')
  // 模块版本也真的被「装」上了（测试里假 pnpm 不装，所以这里只是确认检测口径）
  const after = await collectChecks(ctx)
  assert(after.versions.drift.length === 0, '修完还有漂移')
  rmSync(dirs.root, { recursive: true, force: true })
})

/* ── 2. package.json 坏掉：从快照恢复 ──────────────────────────────── */
const t2 = check('package.json 坏掉能从快照恢复', async () => {
  const dirs = makeSandbox('restore')
  writeProfile(dirs, { '@deepseek-ai/dsh-compaction-basic': CORE })
  const ctx = baseCtx(dirs)
  const snap = takeSnapshot(ctx, 'test-good')
  assert(snap.ok, '快照失败')
  writeFileSync(ctx.profilePkg, '{ this is not json', 'utf8')
  const before = await collectChecks(ctx)
  assert(before.fails.some((f) => f.id === 'profile.package'), '坏掉的 package.json 没被报出来')

  const r = await repair(ctx, { restart: false })
  assert(r.steps.some((s) => s.step === 'restore' && s.ok), '没有执行恢复')
  const pkg = JSON.parse(readFileSync(ctx.profilePkg, 'utf8'))
  assert(pkg.dependencies['@deepseek-ai/dsh-compaction-basic'] === CORE, '恢复出来的内容不对')
  rmSync(dirs.root, { recursive: true, force: true })
})

/* ── 3. 桥接端口漂移：改成新端口且不写 BOM ─────────────────────────── */
const t3 = check('桥接 baseUrl 被改成新端口，且不写 BOM', async () => {
  const dirs = makeSandbox('bridge')
  writeProfile(dirs, { '@deepseek-ai/dsh-compaction-basic': CORE })
  const cfgPath = join(dirs.bridge, 'config.json')
  // 造出带 BOM 的配置（真实踩过的坑）
  writeFileSync(cfgPath, '\uFEFF' + JSON.stringify({ dsh: { baseUrl: 'http://127.0.0.1:1' }, consolePort: 9 }, null, 2), 'utf8')
  const ctx = baseCtx(dirs)
  const r = await syncBridge(ctx, 45678, { restartBridge: false })
  assert(r.ok && r.changed, `syncBridge 失败：${r.detail}`)
  const buf = readFileSync(cfgPath)
  assert(!(buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF), '写回了 BOM（桥接会读不动）')
  const cfg = JSON.parse(buf.toString('utf8'))
  assert(cfg.dsh.baseUrl === 'http://127.0.0.1:45678', `baseUrl 不对：${cfg.dsh.baseUrl}`)
  assert(cfg.consolePort === 9, '不该动别的字段')
  rmSync(dirs.root, { recursive: true, force: true })
})

/* ── 4. 重启链路：真杀真起真等端口（用一个叫 fakehost 的替身进程）───── */
const t4 = check('重启链路：杀掉旧进程 → 启动 → 等到端口', async () => {
  const dirs = makeSandbox('restart')
  writeProfile(dirs, { '@deepseek-ai/dsh-compaction-basic': CORE })
  const nodeExe = process.execPath
  const fakeExe = join(dirs.root, 'fakehost.exe')
  copyFileSync(nodeExe, fakeExe)
  const portFile = join(dirs.root, 'fake-port.txt')
  const fixture = join(here, 'fixtures', 'fake-host.mjs')

  const ctx = resolveContext({
    profileDir: dirs.profile,
    dshHome: dirs.root,
    qqAgentDir: dirs.qq,
    bridgeHome: dirs.bridge,
    bridgePort: 9,
    appExe: fakeExe,
    appRoot: dirs.root,
    processName: 'fakehost',
    nodeExe,
    coreVersionOverride: CORE,
    launchArgs: [fixture, portFile],
  })

  const r = await restartHost(ctx, { timeoutMs: 60_000 })
  assert(r.ok, `重启失败：${r.detail}`)
  assert(r.port > 0, '没等到端口')
  assert(existsSync(portFile), '假宿主没写出端口文件')
  assert(Number(readFileSync(portFile, 'utf8')) === r.port, `等到的端口 ${r.port} 与进程自报的不一致`)
  const urlFile = join(dirs.logs, 'dsh-web-url.txt')
  assert(existsSync(urlFile) && readFileSync(urlFile, 'utf8').includes(String(r.port)), '没更新 dsh-web-url.txt')

  const k = await killHost(ctx)
  assert(k.ok, `收尾杀进程失败：${k.detail}`)
  await new Promise((res) => setTimeout(res, 1500))
  rmSync(dirs.root, { recursive: true, force: true })
})

/* ── 5. 锁：正在修的时候不能重复修 ─────────────────────────────────── */
const t5 = check('并发修复被锁挡住', async () => {
  const dirs = makeSandbox('lock')
  writeProfile(dirs, { '@deepseek-ai/dsh-compaction-basic': '0.2.1-alpha.2' })
  const ctx = baseCtx(dirs)
  writeFileSync(ctx.lockFile, JSON.stringify({ pid: 1, at: new Date().toISOString() }), 'utf8')
  const r = await repair(ctx, { restart: false })
  assert(r.busy === true, `应有 busy，实际 ${JSON.stringify(r.steps)}`)
  rmSync(dirs.root, { recursive: true, force: true })
})

/* ── 6. 插件装载表 YAML 坏掉：报出来并从快照恢复 ──────────────────── */
const t6 = check('cordis.patch.yml 坏掉能被发现并恢复', async () => {
  const dirs = makeSandbox('yaml')
  writeProfile(dirs, { '@deepseek-ai/dsh-compaction-basic': CORE })
  assert(provideYaml(dirs), '本机 profile 里没有 yaml 包，无法验证 YAML 解析路径')
  const ctx = baseCtx(dirs)
  const good = readFileSync(ctx.profilePatch, 'utf8')
  assert(takeSnapshot(ctx, 'test-yaml').ok, '快照失败')
  writeFileSync(ctx.profilePatch, '- insert:\n    - id: [\n      name: : :\n', 'utf8')
  const before = await collectChecks(ctx)
  assert(before.fails.some((f) => f.id === 'profile.patch'), '坏掉的 YAML 没被报出来')

  const r = await repair(ctx, { restart: false })
  assert(r.steps.some((s) => s.step === 'restore' && s.ok), '没有执行恢复')
  assert(readFileSync(ctx.profilePatch, 'utf8') === good, '恢复出来的 YAML 内容不对')
  rmSync(dirs.root, { recursive: true, force: true })
})

/* ── 跑 ────────────────────────────────────────────────────────────── */
export async function runSelfTest() {
  console.log(`DSH doctor 自测（${new Date().toLocaleString('zh-CN', { hour12: false })}）`)
  for (const t of [t1, t2, t3, t4, t5, t6]) {
    try {
      await t.fn()
      record(t.name, true)
    } catch (e) {
      record(t.name, false, String(e?.message || e))
    }
  }
  const bad = results.filter((r) => !r.ok)
  console.log('')
  console.log(`${results.length - bad.length}/${results.length} 通过`)
  return bad.length === 0
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('test/run.mjs')) {
  const ok = await runSelfTest()
  process.exitCode = ok ? 0 : 1
}

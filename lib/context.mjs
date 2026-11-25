// 路径与配置解析：全部「留空就自动发现」，发现不到就返回空串，绝不在初始化时抛异常。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const exeName = 'DeepSeek Harness.exe'
const processName = 'DeepSeek Harness'
const bundleRoot = dirname(dirname(fileURLToPath(import.meta.url)))

export function readJsonSafe(file) {
  try {
    return JSON.parse(String(readFileSync(file, 'utf8')).replace(/^\uFEFF/, ''))
  } catch { return null }
}

function isFile(p) {
  try { return !!p && existsSync(p) && statSync(p).isFile() } catch { return false }
}

function firstFile(list) {
  for (const p of list) { if (isFile(p)) return p }
  return ''
}

/** 在某个目录下按名字找文件，限定深度，跳过 node_modules。 */
export function findFile(root, name, maxDepth = 3) {
  if (!root || !existsSync(root)) return ''
  const seen = new Set()
  const walk = (dir, depth) => {
    if (depth < 0 || seen.has(dir)) return ''
    seen.add(dir)
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return '' }
    for (const e of entries) {
      if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return join(dir, e.name)
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const hit = walk(join(dir, e.name), depth - 1)
      if (hit) return hit
    }
    return ''
  }
  try { return walk(root, maxDepth) } catch { return '' }
}

function findDirWith(root, fileName, maxDepth = 2) {
  if (!root || !existsSync(root)) return ''
  const seen = new Set()
  const walk = (dir, depth) => {
    if (depth < 0 || seen.has(dir)) return ''
    seen.add(dir)
    if (isFile(join(dir, fileName))) return dir
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return '' }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const hit = walk(join(dir, e.name), depth - 1)
      if (hit) return hit
    }
    return ''
  }
  try { return walk(root, maxDepth) } catch { return '' }
}

function discoverAppExe(cfg) {
  if (cfg.appExe) return cfg.appExe
  // 1) 在 DSH 内部运行时，process.execPath 就是桌面壳本体
  if (process.versions?.electron && /DeepSeek Harness\.exe$/i.test(process.execPath || '')) return process.execPath
  // 1b) Electron 的 resourcesPath 一定指向 <安装目录>\resources，反推最稳
  if (process.resourcesPath && /[\\/]resources[\\/]?$/i.test(process.resourcesPath)) {
    const guess = join(dirname(process.resourcesPath.replace(/[\\/]+$/, '')), exeName)
    if (isFile(guess)) return guess
  }
  // 2) 常见安装位置
  const candidates = [
    'D:\\AAA\\AI\\' + exeName,
    join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', exeName),
    join(process.env.LOCALAPPDATA || '', 'Programs', 'dsh', exeName),
    join(process.env.ProgramFiles || '', 'DeepSeek Harness', exeName),
  ]
  const direct = firstFile(candidates)
  if (direct) return direct
  // 3) 在几个根目录里浅扫一遍
  const roots = ['D:\\AAA\\AI', 'D:\\AAA', 'C:\\Program Files', 'C:\\Program Files (x86)']
  for (const r of roots) {
    const hit = findFile(r, exeName, 2)
    if (hit) return hit
  }
  return ''
}

/** asar 候选路径：安装目录推不出来时，退到已知位置逐个试。 */
function asarCandidates(appRoot) {
  const list = []
  if (appRoot) list.push(join(appRoot, 'resources', 'app.asar'))
  if (process.resourcesPath) list.push(join(process.resourcesPath, 'app.asar'))
  list.push('D:\\AAA\\AI\\resources\\app.asar')
  const fromExec = process.execPath ? join(dirname(process.execPath), 'resources', 'app.asar') : ''
  if (fromExec) list.push(fromExec)
  return [...new Set(list.filter(Boolean))]
}

function discoverBridgeHome(cfg, dshHome) {
  if (cfg.bridgeHome) return cfg.bridgeHome
  const candidates = [
    'D:\\AAA\\AI1\\qq-bridge-0.2.1-r1\\qq-bridge-0.2.1-r1',
    join(dshHome, 'qq-bridge'),
  ]
  for (const c of candidates) { if (isFile(join(c, 'config.json'))) return c }
  // 浅扫：找带 config.json 且目录名含 qq-bridge 的
  const roots = ['D:\\AAA\\AI1', 'D:\\AAA', join(homedir(), '.dsh')]
  for (const r of roots) {
    try {
      for (const e of readdirSync(r, { withFileTypes: true })) {
        if (!e.isDirectory() || !/qq-bridge/i.test(e.name)) continue
        const d = findDirWith(join(r, e.name), 'config.json', 1)
        if (d) return d
      }
    } catch { /* ignore */ }
  }
  return ''
}

function runtimeNodeFor(appRoot) {
  if (!appRoot) return ''
  return join(appRoot, 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe')
}

/** 读配置文件：显式路径 > 包根目录 > DSH_HOME。读不到就是空对象。 */
function loadConfigFile(dshHome, explicit) {
  const candidates = [
    explicit || process.env.DSH_DOCTOR_CONFIG || '',
    join(bundleRoot, 'dsh-doctor.config.json'),
    join(dshHome, 'dsh-doctor.config.json'),
  ].filter(Boolean)
  for (const c of candidates) {
    const j = readJsonSafe(c)
    if (j && typeof j === 'object') return j
  }
  return {}
}

/**
 * 解析运行上下文。优先级：overrides（测试/调用方）> 配置文件 > 自动发现。
 * overrides 支持：dshHome / profileDir / appExe / bridgeHome / bridgePort /
 * qqAgentDir / nodeExe / processName / keepSnapshots / pnpmCli / launchArgs / coreVersionOverride
 */
export function resolveContext(overrides = {}) {
  const dshHome = overrides.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')
  const fileCfg = loadConfigFile(dshHome, overrides.configFile)
  const cfg = { ...fileCfg, ...overrides }

  const profileDir = cfg.profileDir || process.env.DSH_PROFILE_DIR || join(dshHome, 'profiles', 'desktop')
  const appExe = discoverAppExe(cfg)
  const appRoot = appExe ? dirname(appExe) : ''
  const candidates = asarCandidates(appRoot)
  const asarPath = candidates.find((p) => isFile(p)) || candidates[0] || ''
  const qqAgentDir = cfg.qqAgentDir || join(dshHome, 'qq-agent')
  const bridgeHome = discoverBridgeHome(cfg, dshHome)
  const bridgeCfg = bridgeHome ? readJsonSafe(join(bridgeHome, 'config.json')) : null
  const nodeExe = cfg.nodeExe
    || process.env.DSH_DOCTOR_NODE
    || (process.versions?.electron ? process.env.DSH_DESKTOP_NODE_EXECUTABLE || '' : '')
    || firstFile([runtimeNodeFor(appRoot), 'D:\\AAA\\AI1\\nodejs\\node.exe'])
    || process.execPath

  return {
    // 机器相关的
    dshHome,
    profileDir,
    profilePkg: join(profileDir, 'package.json'),
    profilePatch: join(profileDir, 'cordis.patch.yml'),
    profileModules: join(profileDir, 'node_modules'),
    appExe,
    appRoot,
    asarPath,
    processName: cfg.processName || processName,
    nodeExe,
    pnpmCli: cfg.pnpmCli || (appRoot ? join(appRoot, 'resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs') : ''),

    // 周边设施
    qqAgentDir,
    logsDir: join(qqAgentDir, 'logs'),
    snapshotsDir: join(qqAgentDir, 'snapshots'),
    bridgeHome,
    bridgePort: Number(cfg.bridgePort ?? bridgeCfg?.consolePort ?? 3100),

    // 行为参数
    keepSnapshots: Number(cfg.keepSnapshots ?? 30),
    // 跟随 DSH 更新自更新：只更新本插件，永不改 DSH 版本；enabled:false 时只记录
    selfUpdate: {
      enabled: cfg.selfUpdate?.enabled !== false,
      repoDir: cfg.selfUpdate?.repoDir || '',
    },
    launchEnv: cfg.launchEnv || {},
    launchArgs: Array.isArray(cfg.launchArgs) ? cfg.launchArgs : [],
    coreVersionOverride: cfg.coreVersionOverride || '',
    lockFile: join(qqAgentDir, 'dsh-doctor.lock'),
    stateFile: join(qqAgentDir, 'dsh-doctor-state.json'),
  }
}

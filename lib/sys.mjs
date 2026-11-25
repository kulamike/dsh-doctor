// 最小的系统调用层：全平台只用 node 内置模块 + Windows 的 powershell.exe。
// 设计原则：任何外部调用都有超时；任何失败都返回结果对象而不是抛异常——修复工具自己不能崩。

import { spawn } from 'node:child_process'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 跑一个进程，收集输出。永不 reject。 */
export function run(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    let timedOut = false
    let child
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String(e?.message ?? e), timedOut: false })
      return
    }
    let out = ''
    let err = ''
    const cap = opts.maxBuffer ?? 1_500_000
    child.stdout?.on('data', (d) => { if (out.length < cap) out += d.toString('utf8') })
    child.stderr?.on('data', (d) => { if (err.length < cap) err += d.toString('utf8') })
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch { /* ignore */ }
    }, opts.timeout ?? 30_000)
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout: out, stderr: String(e?.message ?? e), timedOut: false })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout: out, stderr: err, timedOut })
    })
  })
}

/** 跑一段 PowerShell（Windows 常驻能力），返回 { code, stdout, stderr }。 */
export function ps(script, opts = {}) {
  return run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeout: opts.timeout ?? 30_000, maxBuffer: opts.maxBuffer },
  )
}

/** 跑 PowerShell 并把 stdout 当 JSON 解析；解析不出来返回 null。 */
export async function psJson(script, opts = {}) {
  const r = await ps(script, opts)
  const text = r.stdout.trim()
  if (!text) return null
  try { return JSON.parse(text) } catch { return null }
}

export const toArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v])

/** 脱树启动：父进程退出后子进程继续活着。返回 pid。 */
export function launchDetached(exe, args = [], opts = {}) {
  const child = spawn(exe, args, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  })
  child.unref()
  return child.pid
}

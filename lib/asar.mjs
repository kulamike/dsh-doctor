// 从 app.asar 里读核心包的 package.json —— 这是唯一「DSH 挂了也读得到」的权威版本来源。
// （日志会过期：DSH 自己重启时没人写它；profile 里的多数派会骗人：整批装错时它们互相一致。）

import { closeSync, openSync, readSync, statSync } from 'node:fs'

/**
 * @param {string} asarPath
 * @param {string} innerPath asar 内部路径，默认 package.json
 * @returns {{ ok: boolean, version?: string, name?: string, error?: string }}
 */
export function readAsarPackage(asarPath, innerPath = 'package.json') {
  let fd
  try {
    if (!asarPath || !statSync(asarPath).isFile()) return { ok: false, error: `找不到 ${asarPath}` }
    fd = openSync(asarPath, 'r')
    const head = Buffer.alloc(16)
    readSync(fd, head, 0, 16, 0)
    const pickleSize = head.readUInt32LE(4)
    const jsonLen = head.readUInt32LE(12)
    if (!jsonLen || jsonLen > 64 * 1024 * 1024) return { ok: false, error: 'asar 头长度异常' }
    const jb = Buffer.alloc(jsonLen)
    readSync(fd, jb, 0, jsonLen, 16)
    const header = JSON.parse(jb.toString('utf8'))
    const base = 8 + pickleSize

    let node = header
    for (const part of String(innerPath).split('/').filter(Boolean)) {
      if (!node.files || !node.files[part]) return { ok: false, error: `asar 里没有 ${innerPath}` }
      node = node.files[part]
    }
    if (node.files || !node.size) return { ok: false, error: `${innerPath} 不是文件` }
    const buf = Buffer.alloc(node.size)
    readSync(fd, buf, 0, node.size, base + Number(node.offset))
    const pkg = JSON.parse(buf.toString('utf8'))
    return { ok: true, version: String(pkg.version || ''), name: String(pkg.name || '') }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  } finally {
    if (fd !== undefined) { try { closeSync(fd) } catch { /* ignore */ } }
  }
}

/** 读核心版本；优先 dsh/package.json（运行时包），退回顶层 package.json（桌面壳）。 */
export function readCoreVersion(asarPath) {
  const runtime = readAsarPackage(asarPath, 'dsh/package.json')
  if (runtime.ok && runtime.version) return { ok: true, version: runtime.version, from: 'dsh/package.json', name: runtime.name }
  const shell = readAsarPackage(asarPath, 'package.json')
  if (shell.ok && shell.version) return { ok: true, version: shell.version, from: 'package.json', name: shell.name }
  return { ok: false, error: runtime.error || shell.error || '读取失败' }
}

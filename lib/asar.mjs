// 从 app.asar 里读核心包的 package.json —— 这是唯一「DSH 挂了也读得到」的权威版本来源。
// （日志会过期：DSH 自己重启时没人写它；profile 里的多数派会骗人：整批装错时它们互相一致。）

import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)
// Electron 主进程里 fs 被 asar 补丁改写过：对 app.asar 本身 statSync 会当成目录，isFile() 为 false。
// original-fs 是未打补丁的版本，能把它当普通文件读。拿不到就退回 node:fs。
let origFs = null
try { origFs = require('original-fs') } catch { origFs = null }
const fsImpl = origFs && typeof origFs.openSync === 'function' ? origFs : null

/**
 * @param {string} asarPath
 * @param {string} innerPath asar 内部路径，默认 package.json
 * @returns {{ ok: boolean, version?: string, name?: string, error?: string }}
 */
export function readAsarPackage(asarPath, innerPath = 'package.json') {
  let fd
  try {
    if (!asarPath) return { ok: false, error: '没有 asar 路径' }
    const st = (fsImpl || { statSync }).statSync(asarPath)
    fd = (fsImpl || { openSync }).openSync(asarPath, 'r')
    const head = Buffer.alloc(16)
    ;(fsImpl || { readSync }).readSync(fd, head, 0, 16, 0)
    const pickleSize = head.readUInt32LE(4)
    const jsonLen = head.readUInt32LE(12)
    if (!jsonLen || jsonLen > 64 * 1024 * 1024) return { ok: false, error: 'asar 头长度异常' }
    const jb = Buffer.alloc(jsonLen)
    ;(fsImpl || { readSync }).readSync(fd, jb, 0, jsonLen, 16)
    const header = JSON.parse(jb.toString('utf8'))
    const base = 8 + pickleSize

    let node = header
    for (const part of String(innerPath).split('/').filter(Boolean)) {
      if (!node.files || !node.files[part]) return { ok: false, error: `asar 里没有 ${innerPath}` }
      node = node.files[part]
    }
    if (node.files || !node.size) return { ok: false, error: `${innerPath} 不是文件` }
    const buf = Buffer.alloc(node.size)
    ;(fsImpl || { readSync }).readSync(fd, buf, 0, node.size, base + Number(node.offset))
    const pkg = JSON.parse(buf.toString('utf8'))
    return { ok: true, version: String(pkg.version || ''), name: String(pkg.name || '') }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  } finally {
    if (fd !== undefined) { try { (fsImpl || { closeSync }).closeSync(fd) } catch { /* ignore */ } }
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

/**
 * 兜底：让普通 node 去读 asar（宿主里 fs 被 Electron 改写、又拿不到 original-fs 时用）。
 * 返回 { ok, version, from } / { ok:false }。
 */
export function readCoreVersionViaNode(asarPath, nodeExe) {
  if (!asarPath || !nodeExe) return { ok: false, error: '缺少 asar 或 node 路径' }
  const script = [
    "const fs=require('fs');const p=process.argv[1];",
    "const fd=fs.openSync(p,'r');const b=Buffer.alloc(16);fs.readSync(fd,b,0,16,0);",
    "const ps=b.readUInt32LE(4),jl=b.readUInt32LE(12);const jb=Buffer.alloc(jl);fs.readSync(fd,jb,0,jl,16);",
    "const h=JSON.parse(jb.toString('utf8'));const base=8+ps;",
    "const get=(n)=>{let x=h;for(const part of n.split('/')){if(!x.files||!x.files[part])return null;x=x.files[part]}return x};",
    "for(const n of ['dsh/package.json','package.json']){const e=get(n);if(!e||e.files)continue;",
    "const buf=Buffer.alloc(e.size);fs.readSync(fd,buf,0,e.size,base+Number(e.offset));",
    "const pkg=JSON.parse(buf.toString('utf8'));console.log(JSON.stringify({ok:true,version:pkg.version,name:pkg.name,from:n}));process.exit(0)}",
    "console.log(JSON.stringify({ok:false,error:'asar 里没有 package.json'}))",
  ].join('')
  try {
    const r = spawnSync(nodeExe, ['-e', script, asarPath], { encoding: 'utf8', timeout: 20000, windowsHide: true })
    const line = String(r.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || ''
    const j = JSON.parse(line)
    return j?.ok ? j : { ok: false, error: j?.error || '子进程没给出结果' }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}
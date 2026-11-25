# DSH 急救箱（dsh-doctor）

给 DeepSeek Harness 做体检和修复。**修复引擎不依赖 DSH**——DSH 起不来的时候，双击桌面上的 `repair.cmd` 就能跑。

## 它查什么

| 检查 | 说明 |
|---|---|
| profile 文件 | `package.json` 能不能解析、`cordis.patch.yml` 的 YAML 有没有坏 |
| 核心版本 | 从 `app.asar` 里读 `@deepseek-ai/dsh-desktop-runtime` 的版本（DSH 挂了也读得到） |
| 依赖版本 | profile 里 `@deepseek-ai/dsh-*` 是否都等于核心版本 |
| 依赖落地 | `node_modules` 里真的装上了，而且版本对 |
| 进程 / 端口 / HTTP | 有没有主进程、有没有监听、`/api/sessions` 回不回话（401 算活） |
| 桥接 | `dshReady` 是不是 true、桥接写的端口和 DSH 实际端口是否一致 |
| 日志 | `dsh-web.err.log` 里有没有致命错误 |
| 磁盘 / 快照 | C 盘空间、有没有可用配置快照 |

「进程在、端口通」不算可用：桥接的 `dshReady=false` 才是最接近「她真的不能用」的判据。

## 它修什么

1. **配置快照**——动手前先把 `package.json` + `cordis.patch.yml` 存一份（默认保留 30 份）
2. **版本漂移**——把 `@deepseek-ai/dsh-*` 对齐到 `app.asar` 里的核心版本（改前留 `.bak-doctor-*`）
3. **重装依赖**——用 DSH 自带的 pnpm 在 profile 里 `pnpm install`，让 `node_modules` 跟上
4. **恢复坏配置**——`package.json` / `cordis.patch.yml` 坏了就从最近快照恢复，再重装
5. **重启 DSH**——起不来/不能用时杀掉进程树、重新拉起、等新端口、更新 `dsh-web-url.txt`
6. **桥接端口**——`dsh.baseUrl` 对齐到实际端口（**UTF-8 无 BOM**，否则桥接读不动），必要时重启桥接

修完会再体检一遍，把「修前几个故障 → 修后几个故障」写出来。

## 两种用法

**在 DSH 里**（它还能用的时候）——五个工具：

- `dsh__status` 体检
- `dsh__repair` 修复（默认演练；**拒绝在 DSH 内部重启自己**，那会掐断会话）
- `dsh__snapshot` / `dsh__rollback` / `dsh__logs`

**在 DSH 外面**（它已经坏了）：

```
repair.cmd                  # 体检 + 修复 + 需要时重启，窗口不关
doctor.cmd                  # 只看不改
node bin\cli.mjs status --verbose
node bin\cli.mjs repair --apply --restart
node bin\cli.mjs repair --json      # 给脚本/看护任务用
node bin\cli.mjs rollback --snapshot <名字>
node bin\cli.mjs selftest           # 跑故障注入自测
```

`repair.cmd` / `doctor.cmd` 会自己找 node：优先 DSH 自带的 runtime node，其次便携版 node，最后 `PATH`。

## 边界与限制

- **只在 Windows 上验证过**（进程/端口用 PowerShell 查）。
- 只改 profile 的 `package.json`、`cordis.patch.yml`、`node_modules`，以及桥接的 `config.json` 里的 `dsh.baseUrl`；**不碰会话、角色卡、记忆、日志内容**。
- 快照只存这两个配置文件，不是整个 profile 的备份。
- 「插件加载失败」这类**单个插件**的问题只能报出来，不能替你决定停用哪个。
- 修复用的是 DSH 自带的 pnpm；如果 `resources/runtime` 被删了，会报 `pnpm install` 跳过而不是硬猜。
- 并发有锁（`qq-agent\dsh-doctor.lock`，15 分钟视为陈旧），看护任务和你手点不会同时改 profile。

## 自测

`node test/run.mjs` 会造五种坏法验证：版本漂移、`package.json` 损坏、桥接 BOM、重启链路（真起一个替身进程）、并发锁。2026-11-24 实测 5/5 通过。

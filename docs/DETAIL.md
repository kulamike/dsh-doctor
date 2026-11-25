# DSH 急救箱（dsh-doctor）

给 DeepSeek Harness 做体检与修复。**修复引擎只用 Node 标准库、不依赖 DSH**——DSH 起不来的时候，双击桌面上的 `repair.cmd` 就能跑。

## 一句话定位

「进程在、端口通、err 日志干净」不等于能用。最常见的那种坏法是插件依赖被整批装成了别的版本：DSH 起得来，插件 API 对不上，人却看不出哪里错了。这个插件把「查 → 修 → 复诊」做成一条能重复跑的流程，判据只有两条：

- 核心版本只信 `app.asar`——日志会过期，profile 里的「多数派」会互相印证错误。
- 能不能用看桥接的 `dshReady`，不是看进程在不在。

## 查什么

体检是只读的，不改任何东西；最多 13 项，按严重程度排序（`❌` 故障 → `⚠️` 警告 → `✅` 正常）。

| 分组 | 检查项 | 判据 |
|---|---|---|
| 配置文件 | `profile.package` | `package.json` 能否解析 |
| 配置文件 | `profile.patch` | `cordis.patch.yml` 是否存在、非空、YAML 能否解析 |
| 版本与依赖 | `core.version` | 从 `app.asar` 读 `@deepseek-ai/dsh-desktop-runtime` 的版本 |
| 版本与依赖 | `deps.version` | profile 里每个 `@deepseek-ai/dsh-*` 是否等于核心版本 |
| 版本与依赖 | `deps.modules` | `node_modules` 里装上的版本是否与声明一致 |
| 进程 · 端口 · HTTP | `host.process` | 有没有主进程（Electron 子进程单独计数） |
| 进程 · 端口 · HTTP | `host.port` | 有没有监听端口 |
| 进程 · 端口 · HTTP | `host.http` | `/api/sessions` 是否回话（`401` 也算活着） |
| 桥接 | `bridge.ready` | 桥接 `/status` 的 `dshReady` 是不是 true |
| 桥接 | `bridge.baseUrl` | 桥接写的端口与 DSH 实际监听端口是否一致 |
| 日志 · 磁盘 · 快照 | `logs.err` | `dsh-web.err.log` 尾部有没有致命错误 |
| 日志 · 磁盘 · 快照 | `disk.free` | C 盘剩余空间（< 6GB 警告，< 2GB 故障） |
| 日志 · 磁盘 · 快照 | `snapshot.recent` | 有没有可用配置快照 |

「可用」是三件事同时成立：有主进程、HTTP 活着、桥接 `dshReady` 为 true（没装桥接时该项不参与）。

## 修什么

按固定顺序执行，每步都回报「做了什么、改了什么」：

| # | 步骤 | 做什么 |
|---|---|---|
| 1 | 快照 | 动手前先存一份配置（默认保留 30 份） |
| 2 | 对齐版本 | 把 `@deepseek-ai/dsh-*` 改成 `app.asar` 里的核心版本，原文件留 `.bak-doctor-*` |
| 3 | 重装 | 用 DSH 自带的 pnpm 在 profile 里 `pnpm install` |
| 4 | 恢复配置 | `package.json` / `cordis.patch.yml` 坏了就从最近快照恢复，再重装 |
| 5 | 重启 | 杀进程树 → 重新拉起 → 等新端口 → 刷新 `dsh-web-url.txt` |
| 6 | 桥接 | 把 `dsh.baseUrl` 对齐实际端口（**UTF-8 无 BOM**），必要时重启桥接 |

修完会再体检一遍，给出「修前 N 个故障 → 修后 N 个」。

## 怎么用

**DSH 还活着**——让它自己查，五个工具：

| 工具 | 作用 |
|---|---|
| `dsh__status` | 体检，只读；`verbose` 连正常项一起列 |
| `dsh__repair` | 修复，默认演练；**在 DSH 内部拒绝重启自己**（会掐断当前会话） |
| `dsh__snapshot` | 存一份 profile 配置快照 |
| `dsh__rollback` | 用快照恢复配置（不重启，重启后生效） |
| `dsh__logs` | 读 `err` / `out` / `capture` / `rescue` / `bridge` 日志尾巴 |

**DSH 已经坏了**——在 DSH 外面跑，只要 node：

```powershell
repair.cmd                               # 体检 + 修复 + 需要时重启，窗口不关
doctor.cmd                               # 只看不改
node bin\cli.mjs status --verbose         # 全部检查项
node bin\cli.mjs repair                  # 演练：只打印计划
node bin\cli.mjs repair --apply --restart
node bin\cli.mjs repair --json            # 给脚本 / 看护任务
node bin\cli.mjs rollback --snapshot <名字>
node bin\cli.mjs logs --which err --lines 80
node bin\cli.mjs guard                    # 看护：只修不需要重启的问题
node bin\cli.mjs selftest                 # 跑故障注入自测
```

`repair.cmd` / `doctor.cmd` 会自己找 node：优先 DSH 自带的 runtime node，其次便携版 node，最后 `PATH`。`status` 的退出码只在「健康」时为 0，可以直接当探针用。

## 边界

| 限制 | 说明 |
|---|---|
| 平台 | 只在 Windows 上验证过（进程/端口走 PowerShell） |
| 改动范围 | 只改 profile 的 `package.json`、`cordis.patch.yml`、`node_modules`，以及桥接 `config.json` 里的 `dsh.baseUrl`；不碰会话、角色卡、记忆、日志内容 |
| 快照 | 只存那两个配置文件，不是整个 profile 的备份 |
| 单个插件 | 「插件加载失败」只能报出来，不替你决定停用哪个 |
| pnpm | 用 DSH 自带的；`resources\runtime` 被删了会报「跳过」，不硬猜 |
| 重启 | 在 DSH 内部永远拒绝重启自己，重启只能由外部启动器或看护任务做 |
| 并发 | 有文件锁（`qq-agent\dsh-doctor.lock`，15 分钟视为陈旧） |

## 自测

```powershell
node test\run.mjs          # 等价于 node bin\cli.mjs selftest
```

六个故障注入用例，都在临时目录里造，不碰真实 profile：

| 用例 | 验的是 |
|---|---|
| 版本漂移 | 检出漂移 → 改 `package.json` → 调 pnpm（替身 pnpm 记账） |
| `package.json` 损坏 | 报故障 → 从快照恢复 → 能重新解析 |
| `cordis.patch.yml` 损坏 | YAML 解析失败能被发现 → 恢复成原文 |
| 桥接端口漂移 | 改写 `dsh.baseUrl` 且**不写 BOM** |
| 重启链路 | 真杀、真起、真等端口（替身进程 `fakehost`） |
| 并发锁 | 修复进行中，第二个修复被挡住 |

最后一个用例会真的起一个替身进程再杀掉，比前五个慢。

## 跟随 DSH 更新（可关）

DSH 升级后核心版本会变。插件每次激活时对比一次：**只在核心版本变化时**才 `git pull` 它自己的仓库；
**从不修改 DSH 版本、不动 profile 依赖、不跑 pnpm**。

- 开关：`cordis.patch.yml` 的 `selfUpdate.enabled`（写死配置），或工具 `dsh__selfupdate mode=disable|enable`（持久写状态文件）
- 只看不动：`dsh__selfupdate`（默认 mode=check）；命令行 `node bin/cli.mjs selfupdate [--apply]`
- 目录有未提交改动时**拒绝拉取**，避免覆盖
- 状态记录在 `qq-agent/dsh-doctor-state.json`（上次核心版本、上次拉取结果）
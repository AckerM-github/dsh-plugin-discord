# dsh-plugin-discord

把 **Discord** 接进 **DeepSeek Harness** 的原生插件（cordis 插件 / DSH bundle）。

装上它之后，DSH 进程里会运行一个 Discord bot：每条 Discord 消息（服务器频道 @bot、线程、私信）都会进入一个真实的、持久化的 DSH 会话；回复发回 Discord。会话出现在 DSH 自己的历史里，复用 DSH 的模型凭据、默认模型、工具和工作区，不需要另起一个网关进程。

> 这是 DSH 插件版。仓库外还有一个独立网关版 `dsh-connect`（通过官方 SDK 子进程接入，适合不想改 DSH profile 的场景）；两者面向不同部署方式，功能等价。

> **已验证**：`pnpm add github:AckerM-github/dsh-plugin-discord#v0.1.2` 与 `dsh plugin --profile <p> add github:...` 均安装成功（隔离 profile 实测）；插件在真实 DSH host 中加载、Discord 已连通。

## 特性

- **真正的插件**：以 cordis bundle 形式装进 DSH profile，由 DSH host 进程加载；插件管理页可见、可启停。
- **原生会话**：使用公开的 `ctx.agents` API 创建/恢复会话；每个 Discord 频道/线程/私信对应一个持久化 DSH session，重启 DSH 后可继续。
- **复用 DSH 默认模型**：不配置 provider/model 时使用 DSH 当前默认模型路由；也可以按插件配置覆盖。
- **可见的进度**：回合中维护「正在处理…」状态消息，实时显示工具调用活动；完成后发送最终答案。
- **长回复切分**：按换行/代码块安全切分到 Discord 2000 字符限制，代码块自动闭合/续开。
- **附件**：图片保存到状态目录并在 prompt 中给出路径（agent 可用 `read_image` 查看）；其他文件同样落盘并给出路径。
- **命令**：`!new` / `!status` / `!help`，以及 `/dsh new|status|help` 斜杠命令。
- **安全与背压**：服务器/频道/用户白名单、每用户限流、每会话串行、超长消息拒绝、token 只从本机文件/环境变量读取，不写入配置和仓库。
- **失败软着陆**：配置错误、Discord 登录失败只记日志并保持 dormant，不会阻止 DSH 启动。

## 架构

```text
Discord  ── discord.js ──▶  lib/discord/  ──Inbound──▶  lib/index.js（命令/限流/状态消息/切分）
                                                              │
                                                              ▼
                                                   lib/agent-bridge.js
                                            ctx.agents.create / resume / get
                                                              │
                                                              ▼
                              DSH 会话（同一进程；历史、工具、模型、工作区全部复用）
```

- 会话键 = Discord conversationId（`dm:<userId>` / `guild:<guildId>:<channelId>` / `thread:<guildId>:<threadId>`，`sessionScope=user` 时追加 `:user:<id>`）。
- 映射持久化在 `<stateDir>/sessions.json`（默认 `<DSH_HOME>/dsh-plugin-discord`）。
- 如果会话已经在 DSH 里活着（例如你在 Web UI 打开了它），插件直接复用该 Agent，不会重复创建。
- 回合进行中通过 DSH `session/event` 事件流驱动状态消息；回合结束（`whenIdle`）后发送最终答案。

## 安装

### 从 GitHub 安装（推荐）

要求：DSH Desktop **0.2.2-rc.1**（插件 engines 约束 `>=0.2.2-rc.1 <0.3.0`）、一个 Discord bot token。

1. 把插件装进 DSH profile（`dsh plugin` 底层就是 pnpm；`#v0.1.2` 可省略或换版本 tag）：

```powershell
& 'E:\deepseekharness\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add github:AckerM-github/dsh-plugin-discord#v0.1.2
```

2. 在 DSH 的 **Plugins（插件）** 页面启用 `dsh-plugin-discord` bundle。

也可以直接在 profile 目录用 pnpm 安装（profile 目录是 `~/.dsh/profiles/desktop`）：

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$pnpm = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs"
cd "$env:USERPROFILE\.dsh\profiles\desktop"
& $node $pnpm add github:AckerM-github/dsh-plugin-discord
```

然后在 profile 的 `package.json` 的 `dsh.profile.bundles` 里加入 `"dsh-plugin-discord"`（或 Plugins 页面启用）。

> 前置要求：需要 **Git for Windows**（pnpm 安装 github: 包需要调用 git；安装时勾选把 Git 加进 PATH）。
> 仓库提供一键脚本，会自动定位 Git 和 DSH CLI，并可顺带设置代理：
>
> ```powershell
> powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-github.ps1 -Proxy http://127.0.0.1:7890
> # 只检查不安装：-DryRun
> ```
>
> 国内网络提示：pnpm 通过系统 `git` 拉取 GitHub。如果直连失败，可给 git 配代理
> `git config --global http.proxy http://127.0.0.1:7890`，或改用 SSH（`git config --global url."git@ssh.github.com:443/".insteadOf "https://github.com/"`，需要 GitHub SSH key）。

### 配置（profile patch）

在 `~/.dsh/profiles/desktop/cordis.patch.yml` 末尾追加（保持 YAML 顶层数组格式）：

```yaml
- id: discord
  config:
    stateDir: C:/Users/<你>/.dsh/dsh-plugin-discord
    proxy: http://127.0.0.1:7890          # 需要代理访问 Discord 时；不需要可删除
    runtime:
      workspace: E:/your/project           # agent 的工作目录
      # provider: deepseek-official        # 不填则用 DSH 当前默认模型
      # model: deepseek-flash
    # 该文件含 bot token，建议仅当前用户可读（tokenFile 避免 Windows 环境变量不继承问题）
    tokenFile: C:/Users/<你>/.dsh/dsh-plugin-discord/token.txt
    discord:
      requireMentionInGuild: true
      sessionScope: thread                 # thread | channel | user
      commandPrefix: "!"
      allowGuilds: ["你的服务器ID"]         # 强烈建议收紧白名单
      allowChannels: []
      allowUsers: []
      attachments:
        enabled: true
        maxBytes: 8000000
        maxCount: 4
      registerSlashCommands: true
      reply:
        typingIndicator: true
        activityUpdates: true
```

### 提供 bot token

推荐写进只有当前用户可读的文件（比环境变量可靠）：

```powershell
$dir = "$env:USERPROFILE\.dsh\dsh-plugin-discord"
New-Item -ItemType Directory -Force $dir | Out-Null
Set-Content -Path "$dir\token.txt" -Value "你的 bot token" -NoNewline
icacls "$dir\token.txt" /inheritance:r /grant:r "$($env:USERNAME):(R)"
```

也支持 `discord.token: env:DISCORD_BOT_TOKEN`（需要把变量设进 DSH 进程环境，Windows 上不总是可靠）。

### 重启 DSH

完全退出 DSH Desktop（托盘退出）再打开。日志出现 `Discord channel started` 即成功，之后在 Discord 里 @bot 或私信它。

### 本地开发安装（可选）

从本地目录链接安装（改代码后重启 DSH 生效）：

```powershell
& 'E:\deepseekharness\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add link:E:\path\to\dsh-plugin-discord
```

开发/测试流程见 [docs/install-dev.md](docs/install-dev.md)。

## 配置参考（插件 config）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `discord.token` | —（回退 `DISCORD_BOT_TOKEN`） | Bot token；支持 `env:NAME` 引用 |
| `discord.applicationId` | 自动推断 | 注册 `/dsh` 斜杠命令用 |
| `discord.requireMentionInGuild` | `true` | 服务器频道需 @bot（命令除外） |
| `discord.sessionScope` | `thread` | `thread` / `channel` / `user` |
| `discord.commandPrefix` | `!` | 文本命令前缀 |
| `discord.allowGuilds/allowChannels/allowUsers` | `[]`（不限制，不推荐） | 白名单；空数组=允许所有 |
| `discord.attachments` | 开启，8MB/4 个 | 图片进文件路径提示，其他文件落盘 |
| `discord.registerSlashCommands` | `true` | 注册 `/dsh` |
| `discord.reply.typingIndicator` | `true` | 输入中指示 |
| `discord.reply.activityUpdates` | `true` | 状态消息显示工具活动 |
| `runtime.workspace` | DSH 默认 | 会话工作目录 |
| `runtime.provider/model/reasoningEffort/maxTokens` | DSH 默认 | 模型路由覆盖 |
| `stateDir` | `<DSH_HOME>/dsh-plugin-discord` | 会话映射 / 附件 |
| `tokenFile` | — | 从文件读取 bot token（推荐；避免 Windows 环境变量不继承问题） |
| `proxy` | — | Discord 出站 HTTP 代理，如 `http://127.0.0.1:7890`（见下方网络说明） |
| `channelContext` | `true` | prompt 前附带「频道/用户」上下文行 |
| `instructions` | — | 附加到每条 prompt 前的部署级指令 |
| `activityIntervalMs` | `1200` | 状态消息最短刷新间隔 |
| `maxPromptChars` | `20000` | 单条消息上限 |
| `rateLimit.windowMs/maxMessages` | `10000/8` | 每用户限流 |
| `debugHttpPort` | `0` | 仅开发：loopback 自检端点（见 docs/install-dev.md） |

## 网络（中国大陆 / 公司网络必读）

DSH、Node 进程和 discord.js **不会自动使用 Windows 系统代理**（IE/WinINET 代理只对浏览器和部分程序生效）。如果 Discord 需要代理才能访问，请在插件配置里显式指定：

```yaml
- id: discord
  config:
    proxy: http://127.0.0.1:7890     # 你的 HTTP 代理（Clash/v2rayN 的混合端口）
    discord:
      token: env:DISCORD_BOT_TOKEN
```

插件会为 REST、附件下载和 Gateway WebSocket 分别配置代理，且只影响插件自己的网络栈，不改变 DSH host 其它请求。
验证代理是否可用：浏览器能打开 discord.com 不代表 Node 能直连——启用 `proxy` 后看 DSH 日志是否出现 `Discord channel started`；若报 1006/连接超时，通常是代理地址或端口不对。

## 命令

| 命令 | 说明 |
| --- | --- |
| `!new` / `!reset` | 开启新会话，丢弃该会话排队消息 |
| `!status` | 查看运行时/会话/工作区状态 |
| `!help` | 帮助 |
| `/dsh new\|status\|help` | 斜杠命令（需注册） |

其余消息（服务器需 @bot）交给 agent。回合无法中断（DSH 插件 API 暂不提供取消入口），可用 `!new` 换上下文。

## 安全须知（重要）

- Discord 消息会触发 **DSH agent 的工具执行**（PowerShell、文件读写、网络等）。请务必配置 `allowGuilds / allowChannels / allowUsers`，只允许可信的服务器和用户。
- 给 bot 单独的 `runtime.workspace`，不要直接指向重要目录。
- token 只放环境变量；不要写进仓库或 profile 配置文件。
- 插件按最小权限运行：不要给 bot 账号管理员权限，只授予收发消息/线程/附件所需权限。
- 配置 `debugHttpPort` 会打开仅限 loopback 的自检 HTTP 端点，生产环境请保持 `0`。

## 已验证（本机）

- **单元测试 145/145 通过**（Discord 层 87、agent bridge 42、会话存储/配置/切分/debug 端点 16；全部无网络）。
- **隔离真实 DSH host 端到端通过**：在临时 DSH_HOME 创建 `plugin-e2e` profile（base + web-app + 本插件），`dsh --dump-config` 验证 bundle 组合；真实启动 DSH host 后插件 `/health` 1.5s 内就绪，`POST /selftest` 触发一次真实模型回合并返回 `E2E_PLUGIN_OK`，会话 id 写入 `sessions.json`；**真实 desktop profile 与真实 DSH home 未被触碰/修改**。
- Discord **现场登录**（READY、MESSAGE CONTENT intent、斜杠命令同步、CDN 附件、真实限流）需要你的 bot token，未在开发环境实测；Discord 层逻辑有 87 个假客户端单测覆盖。

## 已知限制

- **无逐字流式**：最终答案在回合结束后发送；回合中通过状态消息展示工具活动。
- **无回合中断**：没有 cancel API；`!new` 仅切换上下文。
- **图片不直接进多模态输入**：图片落盘后由 agent 通过 `read_image` 工具查看。
- **Discord 现场连接未在开发环境实测**（需要真实 token）：登录、Intent、斜杠命令同步需要一次手工冒烟；其余逻辑均有单元测试。
- 会话映射是插件自己的 JSON 文件，不写入 DSH storage。

## 开发与测试

```powershell
cd E:\deepseekworkspace\dsh-plugin-discord
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

# 全部单元测试（143 个，无网络）
& $node --test --test-reporter=spec "test/**/*.test.js"

# 隔离环境真实 DSH 端到端（不动你的 desktop profile；会花一次很便宜的模型回合）
$env:DSH_PLUGIN_E2E = "1"
& $node --test --test-reporter=spec "test/e2e/plugin-e2e.mjs"
$env:DSH_REAL_HOME = "$env:USERPROFILE\.dsh"
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/e2e.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/e2e.ps1 -PrecheckOnly
```

- [docs/bridge.md](docs/bridge.md) — agent bridge 契约、会话生命周期、事件映射。
- [docs/install-dev.md](docs/install-dev.md) — 隔离 e2e harness、debugHttpPort、测试 profile 说明。
- [docs/discord-setup.md](docs/discord-setup.md) — Discord 应用/Bot 创建、Intent、邀请链接与排错。

## 与独立网关版（dsh-connect）的区别

| | dsh-plugin-discord（本仓库） | dsh-connect（独立网关） |
| --- | --- | --- |
| 形态 | DSH 原生插件，装进 profile | 独立 Node 进程 |
| 会话 | 与 DSH host 同进程（可复用 GUI 打开的会话） | 通过官方 SDK 子进程，独立运行时 |
| 适用 | 想直接在自己的 DSH Desktop 里用 | 不想改 profile / 要跑在服务器 / 多渠道网关 |

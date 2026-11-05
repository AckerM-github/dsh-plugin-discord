# Discord 接入指南（插件版）

> 目标：从零创建 Discord Bot，把 `dsh-plugin-discord` 接到你的 DSH Desktop。
> 通用安装/配置见 [README](../README.md)；插件内部实现见 [bridge.md](bridge.md)。

## 0. 它能做什么

- 服务器频道里 @bot 对话；默认每个线程/频道一个会话（`sessionScope` 可调）。
- 私信直接对话。
- 会话自动续接：DSH 重启后继续之前的上下文。
- 图片/文件消息会保存到状态目录，agent 可通过 `read_image`/文件工具查看。

## 1. 创建 Discord 应用与 Bot

1. 打开 <https://discord.com/developers/applications>，**New Application**，起名（例如 `DSH`）。
2. 左侧 **Bot** → **Reset Token** → 复制 token（只显示一次）。这就是 `DISCORD_BOT_TOKEN`。
3. 同一页 **Privileged Gateway Intents** 中开启 **MESSAGE CONTENT INTENT**（必须；否则 bot 收不到消息内容，会报 4014/disallowed intents）。
4. 可选：在 **General Information** 复制 **Application ID**，用于 `/dsh` 斜杠命令（`DISCORD_APPLICATION_ID`）。

## 2. 邀请 Bot 进服务器

在 **OAuth2 → URL Generator** 选择：

- Scopes：`bot`、`applications.commands`
- Bot Permissions：View Channels、Send Messages、Send Messages in Threads、Read Message History、Attach Files、Embed Links、Create Public Threads

生成的邀请链接形如：

```text
https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&permissions=292057893888&scope=bot%20applications.commands
```

把 `<APPLICATION_ID>` 换成你的应用 ID，浏览器打开并选择你的服务器授权。

## 3. 配置插件

在 DSH profile 的 `cordis.patch.yml` 追加（如果 Discord 需要代理，再加一行 `proxy: http://127.0.0.1:7890`，见 README 网络章节）：

```yaml
- id: discord
  config:
    runtime:
      workspace: E:/deepseekworkspace
    discord:
      token: env:DISCORD_BOT_TOKEN
      requireMentionInGuild: true
      allowGuilds: ["你的服务器ID"]
      allowUsers: []
```

设置环境变量后重启 DSH：

```powershell
setx DISCORD_BOT_TOKEN "...."
# 可选
# setx DISCORD_APPLICATION_ID "...."
```

## 4. 冒烟测试（首次接入建议逐项过）

1. DSH 日志出现 `Discord channel started`。
2. 在服务器频道 @bot 说「你好」→ 应出现「正在处理…」然后回复。
3. 私信 bot「你好」→ 应回复。
4. 发送 `!status` → 显示会话信息；发送 `!new` → 提示新会话。
5. 发送一张图片 → 状态消息处理完后，确认 `<stateDir>/attachments/...` 下有文件。
6. （若配置了 applicationId）输入 `/dsh status` → 斜杠命令回复。全局命令同步可能需要几分钟到一小时。

## 5. 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 启动日志提示 no Discord token | 没设 `DISCORD_BOT_TOKEN` 或没重启 DSH；插件保持 dormant 不报错 |
| 报 4014 / disallowed intents | Developer Portal → Bot → 打开 MESSAGE CONTENT INTENT |
| bot 在线但服务器频道无响应 | 默认需 @bot；或服务器/频道/用户在白名单外；或缺 View/Send 权限 |
| 日志报 1006 / 连接超时 / gateway 连不上 | Node 不走系统代理：在插件配置里加 `proxy: http://127.0.0.1:7890` 后重启 DSH |
| 日志报 Used disallowed intents (4014) | Developer Portal → Bot → Privileged Gateway Intents → 打开 MESSAGE CONTENT INTENT 并保存 |
| 私信无响应 | `allowUsers` 为空表示允许所有；非空时要包含你的用户 id |
| `❌ 处理失败` | 看 DSH 日志：通常是模型凭据/路由问题（先在 DSH 里正常对话验证） |
| 斜杠命令不出现 | 没配置/推断不到 `applicationId`，或全局命令尚未同步；也可先用 `!help` |
| 想确认插件是否在运行 | DSH Plugins 页面查看 `dsh-plugin-discord`；或看日志 `dsh-plugin-discord loaded` |

## 6. 安全建议

- 只邀请到可信服务器；用 `allowGuilds`/`allowUsers` 收紧。
- bot 的工具执行能力等于 DSH agent 的能力：不要把它放进陌生服务器，不要给宽泛的 `workspace`。
- 定期轮换 token；泄露后立即在 Developer Portal Reset Token。

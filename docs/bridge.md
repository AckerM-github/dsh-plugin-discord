# Agent Bridge（DSH 原生插件）

本文描述 `lib/agent-bridge.js` 与 `lib/session-store.js`：它们把每个 Discord 会话接到 DSH 宿主进程里的真实 Agent 上。二者都是**纯 ESM JavaScript**，在插件宿主里运行，无需构建。

## 1. 架构与职责

```text
Discord 消息
   │ (lib/index.js handleInbound → buildPromptText)
   ▼
createAgentBridge({ ctx, logger, config, sessionStore })
   │  会话解析：live agent / resume / create
   │  run()：按会话串行、followup、session/event 映射、whenIdle
   ▼
ctx.agents (DSH 宿主服务)  ──►  DSH Agent / Session（出现在 DSH 历史里）
   │
   ▼
createSessionStore({ filePath, logger })
   <DSH_HOME>/dsh-plugin-discord/sessions.json
```

- Discord 会话 key 直接使用 `conversationId`（dm/guild/thread，见 Discord 层）。
- 每个 key 对应一个持久化 DSH session id；session 里保留完整历史，模型、凭据、工具全部复用宿主 DSH 的配置。
- 插件**不创建子进程**：Agent 由宿主 `ctx.agents` 管理，因此会话会出现在 DSH 的历史/Web UI 中。

## 2. 对外契约

### 2.1 createAgentBridge

```js
import { createAgentBridge } from './agent-bridge.js';

const bridge = createAgentBridge({
  ctx,                    // cordis context，必须提供 ctx.agents
  logger,                 // 宿主 logger（debug/info/warn/error）
  config: {
    workspace,            // 新会话的 cwd（meta.cwd）
    provider, model,      // 模型路由；同时提供才生效
    reasoningEffort,      // 可选
    maxTokens,            // 可选，正整数
    channelContext,       // 是否在 prompt 中加一行频道/用户上下文
    instructions,         // 固定前置指令
    turnTimeoutMs,        // 可选，回合超时（测试/未来使用）
  },
  sessionStore,           // 见 2.3
  // 测试注入（可选）：createUserMessage 工厂、now 时钟
});

bridge.run(sessionKey, { text, conversationLabel, userName }, observer)
  -> Promise<{ sessionId, finalText, durationMs }>

bridge.reset(sessionKey)      // 开启新会话；仅销毁插件自己创建的 Agent
bridge.status()               // { ready, liveSessions }
await bridge.dispose()        // 取消订阅、销毁自有 Agent、flush 存储
```

`observer`（全部可选，抛异常不会影响回合）：

| 回调 | 触发 |
| --- | --- |
| `onActivity(line)` | 工具调用/结果，一行简短状态文本（≤120 字符） |
| `onAssistantText(text)` | 每一条已提交的 assistant 消息文本 |
| `onStatus('running' \| 'idle')` | 回合开始/结束（去重） |

### 2.2 会话解析顺序（每个 sessionKey）

1. 本 bridge 已缓存的 Agent 且仍在 `ctx.agents.get(id)` 中存活 → 直接复用；
2. `sessionStore` 里有持久化 session id，且该 Agent 已在宿主里存活（例如 Web UI 打开着）→ **复用但不拥有**（不 dispose）；
3. 有持久化 id → `ctx.agents.resume({ resumeSessionId })`；成功则该 Agent 由插件拥有；
4. resume 失败（会话不存在/不兼容/被占用）→ 记录 warning，创建全新会话：
   - sessionId 由插件生成：`session-<uuid-no-dashes>`；
   - `meta.cwd = config.workspace`（仅当 workspace 非空）；
   - `agentOptions` 来自 config 的 provider/model/reasoningEffort/maxTokens；若 config 未同时给 provider+model，则通过 `ctx.get("agentDefaultModel")`（属性访问仅作兼容回退）读取 `currentSelection()`；仍无完整路由时**不会创建 Agent**，而是抛出可操作错误：`no model route: configure runtime.provider/model or ensure agentDefaultModel is available`；
5. 解析成功后立即把 key → sessionId 写入 `sessionStore`，回合成功后再写一次（附带 label/user 元数据）。

### 2.3 SessionStore 契约

```js
import { createSessionStore } from './session-store.js';

const store = createSessionStore({
  filePath,        // 必填，绝对路径，例如 <DSH_HOME>/dsh-plugin-discord/sessions.json
  logger,          // 可选
  flushDelayMs,    // 可选，写盘防抖，默认 250ms
  now,             // 测试时钟
});

store.get(key)                 // { sessionId, updatedAt, meta? } | undefined
store.set(key, sessionId, meta)// 立即更新内存；磁盘写防抖
store.delete(key)
await store.flush()            // 强制写盘并等待完成（插件 teardown 调用）
store.size                     // 当前记录数
```

文件格式（version 1）：

```json
{
  "version": 1,
  "sessions": {
    "dm:123": {
      "sessionId": "session-...",
      "updatedAt": "2026-11-05T14:00:00.000Z",
      "meta": { "conversationLabel": "DM", "userName": "alice" }
    }
  }
}
```

- **原子写**：先写 `sessions.json.tmp`，再 rename 覆盖，进程崩溃不会得到半截 JSON。
- **防抖**：默认 250ms 合并多次修改；`flush()` 取消防抖并等待写盘。
- **容错**：文件不存在、JSON 损坏或结构未知时只记录 warning，从空表启动；下一次成功写入会修复文件。
- 同步 `get()`（构造时同步读取一次），适配 Discord 命令处理等同步路径。

## 3. run() 执行流程

1. 按 sessionKey 进入内部串行队列（同一会话不会并发跑两个回合；不同会话可并行）。
2. 解析/创建 Agent（见 2.2）。
3. 生成 prompt 文本：`config.instructions` + 频道上下文行 + 用户文本（幂等；若 `lib/index.js` 已拼过同样的前缀不会重复添加）。
4. 构造用户消息：静态导入官方 `createUserMessage`（`@deepseek-ai/dsh-llm`）；测试可注入工厂覆盖。若工厂缺失或抛错，回退本地构造 `{ id: 'msg-<uuid>', role: 'user', content, source: {kind:'user'} }`。
5. 记录语义：插件生命周期内**只订阅一次** `ctx.on('session/event', (session, event) => ...)`，用 `session.seq` 作为**每次 run 的水位线**——seq 小于水位的事件（上一个回合的迟到事件）一律忽略。
6. `agent.followup(message)` 入队并唤醒 Agent。
7. `await agent.whenIdle()`（配置 `turnTimeoutMs` 时用超时包裹；超时会 `agent.cancel({kind:'user'})` 并抛错）。
8. 返回 `{ sessionId, finalText, durationMs }`：
   - `finalText` = 本回合区间内**最后一条** assistant 消息文本；没有则为空字符串；
   - `durationMs` = 从开始排队执行到空闲的耗时。

## 4. 事件映射

| session/event 类型 | 读取字段 | 行为 |
| --- | --- | --- |
| `turn/start` | — | `onStatus('running')` |
| `turn/end` | `data.reason.kind`、`data.reason.error` | `onStatus('idle')`；`kind === 'error'` 时记录失败原因，回合结束后 reject |
| `tool/call` | `data.name`、`data.arguments`（JSON 字符串）、`data.callId` | `onActivity('🛠 <tool>: <参数摘要>')`，并记录 callId → 工具名 |
| `tool/result` | `data.message.toolCallId`、`data.message.isError`、`data.error` | `onActivity('✅ <tool> 完成' / '⚠️ <tool> 失败')` |
| `assistant/message` | `data.message.content` 中的 text block | `onAssistantText(text)`；收集为 finalText 候选 |
| `step/*`、`user/message`、`system/message`、`request/*` 等 | — | 忽略 |

另外订阅 `agent/status`（宿主 Agent 状态变化）与 `agent/error`（驱动/模型错误），按 `agent.id === sessionId` 过滤。状态回调在 run 内去重，通常表现为 `running` → `idle` 各一次。

工具参数摘要按工具挑重点字段（`pwsh/bash → command`、`read/write/edit → file_path`、`grep/glob → pattern`、`web_fetch → url`、`web_search → query`），未知工具回退通用字段；整行 ≤120 字符、摘要 ≤60 字符。

## 5. 失败与恢复

| 场景 | 行为 |
| --- | --- |
| resume 失败 | warning + 新建会话；旧映射被新 id 覆盖 |
| `turn/end` reason=`error` | 记录错误，reject `Error('DSH 回合失败：…')`；**不销毁** Agent/会话，下一条消息继续用同一会话 |
| `agent/error` 事件 | 同上（作为 turn/end 之外的第二条失败信号） |
| `whenIdle()` reject | reject（原错误透传） |
| `turnTimeoutMs` 超时 | `agent.cancel({kind:'user'})` + reject `Error('DSH 回合超时（Nms）')`；会话仍可继续 |
| 创建会话失败 | reject `Error('无法创建 DSH 会话：…')`，不写入映射 |
| 无模型路由（config 与 agentDefaultModel 都缺） | 创建前 reject `Error('no model route: …')`，不调用 `ctx.agents.create` |
| 观察者回调抛异常 | 捕获并记 debug，不影响回合 |
| 缓存 Agent 已失效 | 下次 run 时删除缓存（自有句柄 fire-and-forget dispose），重新走 resume/create |
| dispose 期间仍有回合 | 取消订阅并 dispose 自有 Agent；运行中的 `whenIdle` 由宿主 teardown 结算 |

## 6. 所有权与 reset/dispose

- `ctx.agents.create()/resume()` 返回的 `AgentHandle` 归插件所有 → 记录 `owned: true`；`reset`/`dispose` 才可调用 `handle.dispose()`。
- `ctx.agents.get(id)` 复用的存活 Agent（宿主/Web UI 创建）→ `owned: false`，**永不** dispose。
- `reset(key)`：删除内存缓存与持久化映射，仅当 `owned` 时异步 dispose；宿主会话不受影响。下一次消息创建全新会话。
- `dispose()`：幂等；取消 `session/event`/`agent/status`/`agent/error` 订阅 → dispose 所有自有句柄 → `sessionStore.flush()`。之后 `run()` 以 `agent bridge 已关闭` 拒绝。

## 7. 与 lib/index.js 的集成

插件入口已按如下方式使用（无需其他接线）：

```js
const store = createSessionStore({ filePath: join(stateDir, 'sessions.json'), logger });
const bridge = createAgentBridge({ ctx, logger, config: { ...config.runtime, channelContext, instructions }, sessionStore: store });

const result = await bridge.run(conversationId, { text, conversationLabel, userName }, observer);
bridge.reset(conversationId);   // !new
bridge.status();                 // !status
await bridge.dispose();          // ctx.effect cleanup（之后 index 还会再 flush 一次，安全）
```

> 注意：`lib/index.js` 自己也会拼 instructions + 频道上下文。`buildPromptText` 做了幂等去重，二者同时存在不会重复；后续若简化入口，直接传原始文本即可。

## 8. 安全边界

Agent 在 DSH 宿主进程内运行，**工具调用没有交互式审批**（与 DSH profile 行为一致）：`pwsh`、文件读写等会直接执行。因此：

- Discord 侧的 allowlist（guild/channel/user）就是实际安全边界；不要把 bot 暴露给不可信频道/用户。
- `config.workspace` 决定 Agent 的工作目录；请使用专用目录并遵循最小权限原则运行 DSH。
- DSH home 含凭据与会话历史，不要放进仓库；日志只记录会话 id/错误摘要，不记录 prompt 正文。
- 模型输出与工具结果均不可信；插件只把它当聊天文本经过长度切分后发回 Discord。

## 9. 测试

单元测试不连 Discord、不启动 DSH 宿主、不调用模型：fake ctx 提供 `agents` 注册表与事件总线，Agent 行为可脚本化；session-store 测试使用临时目录。

```powershell
cd E:\deepseekworkspace\dsh-plugin-discord
& "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" `
    --test --test-reporter=spec "test/bridge/**/*.test.js"
```

全部插件单元测试（Discord / 命令 / 配置 / bridge）：

```powershell
& "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" `
    --test --test-reporter=spec "test/**/*.test.js"
```

覆盖范围：

- 新会话创建（id 格式、meta.cwd、agentOptions/默认模型回退/无路由报错）；
- 持久化 resume、resume 失败回退、宿主 live agent 复用且不 dispose；
- 同一会话串行、不同会话并行；
- 事件映射（工具行、assistant 文本、状态流转、seq 水位线忽略迟到事件）；
- turn/end error、agent/error、超时后会话仍可用；
- reset 只销毁自有句柄、dispose 取消订阅/销毁自有句柄/flush/幂等；
- session-store 原子写、防抖、损坏文件容错、跨重启恢复。

## 10. 已知限制

- **回合不可中断**：DSH 协议没有公开的“中断并保留”API；`turnTimeoutMs` 会 cancel 当前回合，但正常回复只能等 `whenIdle()`。
- **事件订阅按 `session.seq` 过滤**：若宿主 Session 实现不提供 `seq`，退化为“本次 run 的 turn/start 之后的事件”，极晚的上一回合事件仍可能被看到。
- **agent/status 依赖宿主事件可见性**：若 cordis 作用域不向插件转发 agent 事件，状态仍由 turn/start/turn/end 推导，功能不受影响。
- **同一会话串行**是桥内防御性队列；插件入口已有每会话单飞逻辑时也安全（双重串行）。
- **进程内状态**：bridge 缓存与订阅只在当前宿主进程有效；跨重启只依赖 `sessions.json` 的 session id。

# 本地开发与隔离 e2e 指南（dsh-plugin-discord）

> 面向在本机开发/验证插件的工程师。本文说明如何在 **完全隔离的临时 DSH_HOME** 里加载这个插件、跑真实模型自测，以及如何一键复现。/
>
> **安全边界**：e2e 与 dev-install 只会写 %TEMP% 下的临时 DSH_HOME；真实 DSH home（默认 `C:\Users\<you>\.dsh`）只读取两个文件：`.credentials.yaml` 与 `.anonymous-user-id`。它们**不会**启动真实的 desktop profile，也不会写入真实 home 的 sessions/ 或 profiles/。

---

## 1. 适用范围与前置条件

这个仓库是**原生 DSH（cordis）插件**，不是独立进程：插件必须由 DSH profile 加载。隔离 e2e 的做法是：

1. 在 %TEMP% 建一个一次性 DSH_HOME；
2. 从真实 home 复制模型凭证（只复制这两个文件）；
3. 生成 profile `plugin-e2e`（`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` + `dsh-plugin-discord`，插件通过 `link:` 指向本仓库）；
4. 用 bundled pnpm 安装依赖，boot `dsh --profile plugin-e2e`，通过插件自带的回环自测端口跑一次真实模型回合；
5. 停进程、删临时目录。

前置条件：

| 依赖 | 说明 |
| --- | --- |
| 真实 DSH home | 默认 `%USERPROFILE%\.dsh`（或 `DSH_HOME`）。必须已有 `.credentials.yaml`，否则自测回合无法调用模型。 |
| DSH CLI | 本机安装的 `dsh.cmd`，例如 `E:\deepseekharness\resources\runtime\cli\bin\dsh.cmd`。脚本会从已知安装位置或 `DSH_CLI` 查找。 |
| bundled Node | 本机通常没有 node 在 PATH：`<home>\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`。脚本默认从这里取，可用 `DSH_NODE` 覆盖。 |
| bundled pnpm | `...\dependencies\pnpm\bin\pnpm.mjs`，与上面 node 配套；可用 `DSH_PNPM` 覆盖。 |
| 执行策略 | 本机默认禁止运行未签名脚本。用 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/...` 或 `pwsh -ExecutionPolicy Bypass -File ...` 运行。 |

> 插件运行在 DSH host 进程里，会使用真实模型凭证。一次 full e2e 只发一条极短的提示词（`Reply with exactly: E2E_PLUGIN_OK`），成本很低，但**不要**在循环里跑。

---

## 2. 一键 e2e（推荐）

### 2.1 完整运行（会跑一次真实模型回合）

~~~powershell
# 在 dsh-plugin-discord 仓库根目录
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/e2e.ps1
~~~

它会依次做：

1. 预检：在临时 profile 上跑 `dsh --profile plugin-e2e --dump-config`，断言 base + web-app + 插件三层都出现、`id: discord` 行被 profile patch 命中（不 boot、不花模型调用）；
2. boot：`dsh --profile plugin-e2e --no-open --host 127.0.0.1 --port <free>`；
3. 等待插件的 `GET /health` 返回 `{ok:true}`（最多 120 秒）；
4. `POST /selftest`，body `{"text":"Reply with exactly: E2E_PLUGIN_OK"}`，断言 HTTP 200、`ok === true`、`reply` 含 `E2E_PLUGIN_OK`，并记录 `sessionId` / `durationMs`；
5. 断言 `<临时 home>\dsh-plugin-discord\sessions.json` 里有本次会话映射（证明数据只落在隔离 home）；
6. taskkill 整个进程树，删除临时 home。

一次实际运行的关键输出（示例）：

~~~text
[plugin-e2e +  0.5s] precheck OK: base + web-app + plugin composed; discord row patched
[plugin-e2e +  2.4s] health OK at http://127.0.0.1:65249/health after 1.6s
[plugin-e2e +  6.4s] selftest answered HTTP 200 in 4.0s
[plugin-e2e +  6.4s] selftest OK: sessionId=session-026daa... durationMs=3987 reply="E2E_PLUGIN_OK"
[plugin-e2e +  6.6s] session store OK: ...\home\dsh-plugin-discord\sessions.json
✔ precheck: isolated profile composes base + web-app + dsh-plugin-discord
✔ e2e: boot isolated DSH, wait for plugin /health, run /selftest through the real bridge
~~~

### 2.2 只跑快速预检（不 boot、不花模型调用）

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/e2e.ps1 -PrecheckOnly
~~~

适合改完 `package.json` / `cordis.patch.yml` 后快速确认 profile 组合与 patch 是否生效。

### 2.3 只验证 boot + /health（不跑模型回合）

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/e2e.ps1 -HealthOnly
~~~

用于排查“插件能否在真实 DSH host 里挂载并 listen”。

### 2.4 保留临时目录（排障）

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/e2e.ps1 -KeepTemp
~~~

- 失败时自动化脚本**默认保留**临时 home，并打印路径与完整 DSH 输出（`<temp>\dsh.log`）；
- 成功时默认删除；加 `-KeepTemp`（或环境变量 `DSH_PLUGIN_E2E_KEEP=1`）则成功也保留。

### 2.5 直接调用 Node 脚本

`scripts/e2e.ps1` 只是把环境变量准备好后调用 Node harness；也可以直接运行：

~~~powershell
$env:DSH_PLUGIN_E2E = "1"
$env:DSH_REAL_HOME = $env:DSH_HOME   # 真实 home，用于复制凭证
$node = "$env:DSH_HOME\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node --test --test-reporter=spec "test/e2e/plugin-e2e.mjs"
~~~

不设置 `DSH_PLUGIN_E2E=1` 时，两个测试都会被 skip（`node --test test/e2e/plugin-e2e.mjs` 只输出 skipped，不会 boot、不会调模型）。

### 2.6 环境变量一览

| 变量 | 作用 |
| --- | --- |
| `DSH_PLUGIN_E2E=1` | 必需；否则 harness 跳过。 |
| `DSH_REAL_HOME` | 真实 DSH home，仅用于复制凭证；默认取 `DSH_HOME`。 |
| `DSH_CLI` | `dsh.cmd` 路径；默认在已知安装位置查找。 |
| `DSH_NODE` | bundled node.exe 路径。 |
| `DSH_PNPM` | bundled pnpm.mjs 路径。 |
| `DSH_PLUGIN_E2E_HOME` | 复用/指定临时根目录（调试用；提供后不会自动删除）。 |
| `DSH_PLUGIN_E2E_KEEP=1` | 成功后也保留临时目录。 |
| `DSH_PLUGIN_E2E_HEALTH_ONLY=1` | 只 boot + /health，跳过模型回合。 |

> 不要复用同一个临时 home 并发跑多个 e2e：profile patch 里的 `debugHttpPort` 是写入文件的，并发会互相覆盖端口。

---

## 3. 手动隔离开发环境

### 3.1 一键准备目录

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev-install.ps1 -DebugHttpPort 8799
~~~

它会创建临时目录、复制凭证、生成 profile、安装依赖，并打印：

~~~text
临时 DSH_HOME : C:\Users\<you>\AppData\Local\Temp\dsh-plugin-e2e-xxxxxxxx\home
工作区        : ...\workspace
profile       : ...\home\profiles\plugin-e2e
隔离环境脚本   : ...\use-env.ps1
debug 端口    : 8799 (仅回环，0 = 关闭)
~~~

常用参数：

| 参数 | 说明 |
| --- | --- |
| `-DebugHttpPort <n>` | 插件回环自测端口，默认 8799；0 表示关闭自测端点。 |
| `-DshHome <path>` | 指定/复用临时 DSH_HOME（默认新建 `%TEMP%\dsh-plugin-e2e-<rand>\home`）。 |
| `-Workspace <path>` | 会话工作区，默认临时 home 同级的 `workspace`。 |
| `-Reuse` | 复用已有临时 home 的 profile 文件（不重写 manifest/patch）。 |
| `-SkipPluginInstall` / `-SkipProfileInstall` | 跳过对应 pnpm install（依赖已就绪时提速）。 |

### 3.2 启动隔离 profile

~~~powershell
# 1) 让当前终端指向临时 home（不会影响真实 profile）
. "<临时根目录>\use-env.ps1"

# 2) 启动（--no-open 避免拉起浏览器；端口可自选）
& "E:\deepseekharness\resources\runtime\cli\bin\dsh.cmd" --profile plugin-e2e --no-open --host 127.0.0.1 --port 8080
~~~

启动后终端会打印 DSH Web 的 tokenized URL（浏览器 UI），同时插件的自测端点在 `http://127.0.0.1:8799`。

### 3.3 手动调用自测端点

~~~powershell
# 健康检查
Invoke-RestMethod http://127.0.0.1:8799/health
# => { ok: true }

# 通过真实 bridge 跑一次模型回合（等价于一条 Discord 消息的处理路径）
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8799/selftest `
  -ContentType "application/json" `
  -Body (ConvertTo-Json @{ text = "Reply with exactly: E2E_PLUGIN_OK" })
# => { ok: true, reply: "E2E_PLUGIN_OK", sessionId: "session-...", durationMs: 3987 }
~~~

在 DSH Web 里打开该 profile 的会话列表，可以看到 `debug:selftest` 对应的会话（会话只存在于临时 home）。

### 3.4 目录结构

~~~text
<temp>\
  use-env.ps1                  # dot-source 后 DSH_HOME/DSH_CLI/DSH_NODE/DSH_PNPM 指向隔离环境
  workspace\                   # bridge 的会话工作区（runtime.workspace）
  home\                        # DSH_HOME
    .credentials.yaml          # 从真实 home 复制（唯一需要的凭证）
    .anonymous-user-id         # 从真实 home 复制（如存在）
    sessions\                  # 本 profile 的会话（删除临时目录即清空）
    dsh-plugin-discord\sessions.json   # 插件自己的 conversation -> session 映射
    profiles\plugin-e2e\
      package.json             # dsh.profile.bundles + link: 依赖
      cordis.yml               # []
      cordis.patch.yml         # id: discord 的 config（workspace/provider/model/debugHttpPort）
      pnpm-workspace.yaml
      node_modules\            # pnpm link 到本仓库
~~~

### 3.5 生成的关键配置

`<temp>\home\profiles\plugin-e2e\package.json`：

~~~json
{
  "name": "dsh-profile-plugin-e2e",
  "private": true,
  "dependencies": { "dsh-plugin-discord": "link:E:/deepseekworkspace/dsh-plugin-discord" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-plugin-discord"] } }
}
~~~

`cordis.patch.yml`（profile 层覆盖插件 bundle 的 `config: {}`）：

~~~yaml
- id: discord
  name: dsh-plugin-discord
  config:
    runtime:
      workspace: <temp>/workspace
      provider: deepseek-official   # 显式兜底路由，e2e 不依赖宿主默认模型
      model: deepseek-flash
    debugHttpPort: 8799
~~~

> `runtime.provider` / `runtime.model` 是**插件配置层的显式路由**，用于让 e2e 在任何 profile 下都有模型可用；宿主 `agentDefaultModel` 的默认选择路径由 bridge 单元测试覆盖。真实安装时可以不填，让插件跟随 DSH 当前默认模型。

### 3.6 清理

停止 DSH 进程后删除整个临时根目录：

~~~powershell
Remove-Item -Recurse -Force "<temp>"
~~~

真实 DSH home 不受影响；它的 `profiles/desktop`、`sessions/` 全程只读/未触碰。

---

## 4. 插件自测端点契约（dev-only）

只有在插件配置 `debugHttpPort > 0` 时启用，只绑定 `127.0.0.1`，用于在没有 Discord bot token 的情况下验证「插件 → bridge → DSH agent → 回复」整条链路。正式使用不要开启。

### 4.1 GET /health

~~~http
GET http://127.0.0.1:8799/health

HTTP/1.1 200 OK
{ "ok": true }
~~~

### 4.2 POST /selftest

请求：

~~~json
{ "text": "Reply with exactly: E2E_PLUGIN_OK", "conversationId": "debug:selftest" }
~~~

- `text`：必填，非空字符串；
- `conversationId`：可选，默认 `debug:selftest`，用于复用/区分会话；
- 请求体上限 64 KiB。

成功响应：

~~~json
{ "ok": true, "reply": "E2E_PLUGIN_OK", "sessionId": "session-...", "durationMs": 3987 }
~~~

失败响应：

| HTTP | body | 场景 |
| --- | --- | --- |
| 400 | `{ "ok": false, "error": "text is required" }` | 缺少/空 `text` |
| 400 | `{ "ok": false, "error": "invalid JSON body: ..." }` | body 不是合法 JSON |
| 500 | `{ "ok": false, "error": "<turn error>" }` | agent 回合失败（模型/路由/工具错误） |
| 404 | `{ "ok": false, "error": "not found" }` | 未知路径 |

> 该端点走的是与 Discord 消息完全相同的 `handleInbound` → `bridge.run` 路径（同样的上下文拼接、会话复用与事件映射），只是跳过 Discord 客户端。

---

## 5. 隔离性说明（为什么不会碰真实 profile）

- 子进程环境变量显式设置为 `DSH_HOME=<temp>`、`DSH_PROFILE=plugin-e2e`，并清掉继承来的 `DSH_PROFILE_DIR` / `DSH_SESSION_ID` / `DSH_WEB_URL`，避免误用真实 desktop profile。
- profile 名固定为 `plugin-e2e`，只存在于临时 home 的 `profiles/` 下；launcher 只按 `--profile plugin-e2e` 解析。
- 真实 home 只做 `Copy-Item` 读取 `.credentials.yaml` / `.anonymous-user-id`；脚本没有对真实 home 的任何写操作。
- 会话日志、会话注册表、插件 session store 全部落在 `<temp>/home`，e2e 成功后整个临时目录删除。
- 失败时保留临时目录只是为了排障；不会把任何内容写回真实 home。

---

## 6. 故障排查

| 现象 | 原因 / 处理 |
| --- | --- |
| `无法加载文件 ... 因为在此系统上禁止运行脚本` | 本机执行策略限制。用 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/...` 运行。 |
| `missing ...\.credentials.yaml` | 真实 home 缺少模型凭证；先在 DSH Desktop 里登录/配置模型，或设置 `DSH_REAL_HOME` 指向有凭证的 home。 |
| `bundled node not found` / `bundled pnpm not found` | 设置 `DSH_NODE` / `DSH_PNPM`，或把 `-NodePath` / `-PnpmPath` 传给 `scripts/e2e.ps1`。 |
| `dsh launcher not found` | 设置 `DSH_CLI` 或 `-DshCli` 指向本机 `dsh.cmd`。 |
| `timed out ... waiting for /health` | 看 `<temp>\dsh.log` 尾部：常见是插件配置校验失败（错误会以 `dsh-plugin-discord: invalid configuration` 打印并保持 dormant）、端口被占用、或 bundle 被跳过。 |
| `EADDRINUSE` | 自测端口或 web 端口被占用；重跑会换随机端口；手动 dev 时改 `-DebugHttpPort` / `--port`。 |
| `skippedBundles: dsh-plugin-discord` | `package.json` 的 `engines.dsh` 与运行版本不匹配，或 bundle patch 路径不可读。运行 `dsh --version` 对照 `engines.dsh`。 |
| selftest 500 `no model route: ...` | 插件没有拿到 `runtime.provider/model`，宿主也没有 `agentDefaultModel`。隔离 profile 已显式写入兜底路由；真实安装时检查插件配置。 |
| selftest 500 模型鉴权错误 | 复制到临时 home 的 `.credentials.yaml` 无效/过期；检查真实 Desktop 里模型是否可用。 |
| 进程残留 | `scripts/e2e.ps1` 用 `taskkill /T /F` 结束整个进程树；若手动启动，关掉终端/DSH Web 进程后删除临时目录。 |

失败时 harness 会输出：

~~~text
[plugin-e2e +  x.xs] FAILED: throwaway DSH home kept for inspection at <temp>\home
[plugin-e2e +  x.xs] FAILED: full DSH output written to <temp>\dsh.log
~~~

---

## 7. 已知限制

- full e2e 需要真实模型凭证，会产生一次极小的真实模型调用；CI 里请用环境变量显式开启（默认 skip）。
- debug 自测端点只用于开发；正式 profile 不要设置 `debugHttpPort`。
- 隔离 e2e 验证的是「插件在真实 DSH host 中加载并走完一次 bridge 回合」，**不**验证 Discord 登录/网关（那需要真实 bot token）；Discord 层逻辑由 `test/discord` 的单元测试覆盖。
- 临时 home 的 cleanup 在 Windows 上偶发文件占用；脚本会重试，若仍残留可手动删除。

---

## 8. 相关文件

| 文件 | 作用 |
| --- | --- |
| [scripts/e2e.ps1](../scripts/e2e.ps1) | 一键隔离 e2e 包装器（设置环境变量后调用 Node harness）。 |
| [scripts/dev-install.ps1](../scripts/dev-install.ps1) | 一键创建可手动把玩的隔离 DSH_HOME + profile。 |
| [test/e2e/plugin-e2e.mjs](../test/e2e/plugin-e2e.mjs) | 真正的流程实现：准备 → dump-config 预检 → boot → /health → /selftest → 清理。 |
| [package.json](../package.json) | bundle 元数据（`dsh.bundle.patch` / `listedByDefault`）与依赖。 |
| [cordis.patch.yml](../cordis.patch.yml) | bundle 的 insert 行（`id: discord`）。 |
| [lib/debug-server.js](../lib/debug-server.js) | 回环自测端点实现。 |
| [lib/agent-bridge.js](../lib/agent-bridge.js) | 插件 → DSH agent 的 bridge（自测与 Discord 共用）。 |


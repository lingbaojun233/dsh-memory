# dsh-memory — 让 DSH 记住跨对话的事，需要时自己想起来

聊天里说过的事，换个会话就忘；同一个人换个群，记忆又串到一起。这个插件把「记住 / 检索 / 遗忘」做成 DSH 的原生工具，模型该记的时候自己记、该查的时候自己查。每条记忆都带证据定位，能追溯也能撤回；宿主注入了用户 / 对话对象 id 时，不同对话之间不会串。

> 这个仓库只是**客户端**。它通过 HTTP 调用一个记忆服务（默认 `127.0.0.1:8767`），服务本身在 [DSH-MultiTool](https://github.com/lingbaojun233/DSH-MultiTool) 的 `memory/` 里。

## 快速开始

### 1. 安装

```powershell
# 进入你的 DSH profile 目录（默认在 C:\Users\你\.dsh\profiles\desktop）
cd "$env:USERPROFILE\.dsh\profiles\desktop"   # 把 desktop 换成你的 profile 名

npm install https://github.com/lingbaojun233/dsh-memory/archive/refs/heads/main.tar.gz
```

约 2 秒装完，没有构建步骤、没有 npm 依赖。

### 2. 启用

打开同一个目录下的 `package.json`。`dependencies` 那行 npm 已经帮你写好了，你只需要把 `dsh-memory` 加进 `dsh.profile.bundles` 的末尾：

```json
{
  "dependencies": {
    "dsh-memory": "https://github.com/lingbaojun233/dsh-memory/archive/refs/heads/main.tar.gz"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-headless",
        "dsh-memory"
      ]
    }
  }
}
```

> 你现有的 `bundles` 里可能有 `@deepseek-ai/dsh-web-app` 等别的条目，保留它们，只在最后追加 `dsh-memory`。
> 改完重启 DSH；headless 模式每次运行都会重新装配，不用手动重启。

### 3. 验证

先确认记忆服务活着：

```powershell
curl.exe -s http://127.0.0.1:8767/v1/health
# {"ok":true,"counts":{"events":...},"version":"..."}
```

新开一个会话，对 DSH 说：

> 记住：我的项目部署在 `D:\apps\demo`，证据用 `chat:local#m1`。存完告诉我事件 id。

成功的样子：DSH 调用 `memory_remember`，返回里带 `"ok": true` 和一个 `eventId`。接着再问一句「我的项目部署在哪」，它会调用 `memory_search` 把这条找回来。

## 它提供哪些工具

| 工具 | 干什么 | 例子 |
|---|---|---|
| `memory_remember` | 写入一条事件。**必须带 `evidence`**（`来源:定位`，例如 `chat:g123#m456`），服务和插件都靠它追溯 | 对 DSH 说「记住：周五交稿，证据 chat:local#m7」 |
| `memory_search` | 按查询召回记忆，双预算（默认 8 条 / 1200 token），每条都带 id 和证据 | 对 DSH 说「上次说的部署路径是什么」 |
| `memory_forget` | 软删一条（`event:123`）；可审计，也能用 `{undo:true, tombstone_id}` 撤销 | 对 DSH 说「忘掉 event:12，理由：我记错了」 |

几个行为细节，避免误会：

- **没人调它就不写**。记忆不会自动注入上下文，是模型自己判断该记/该查时才调用。
- **证据是硬门槛**。没有 `evidence` 的写入会被服务端 400 拒掉（`E_NO_EVIDENCE`），不会写进去。
- **检索为空是合法结果**，返回 `items: []`，模型不会编造。

## 依赖

| 依赖 | 说明 |
|---|---|
| DSH | 已装好即可；插件要求 Node ≥ 18（DSH 自带） |
| 记忆服务 | 默认 `http://127.0.0.1:8767`，必须实现 `/v1/tools/memory_remember`、`/v1/tools/memory_search`、`/v1/tools/memory_forget` 三条 POST |
| 服务端运行时 | DSH-MultiTool 的 `memory/` 用 Node 内置 `node:sqlite`（Node 22+），不需要额外数据库 |

服务从 DSH-MultiTool 里起（Windows）：

```powershell
cd C:\Apps\DSH-MultiTool\memory
node server.js   # 需要 Node 22+（node:sqlite）
# 或者双击 start-server.cmd（它用 core\runtime 里的便携 Node）
```

数据不在插件里，而在服务端：

```text
<DSH-MultiTool>\data\memory\memory.db        记忆库（SQLite + FTS5）
<DSH-MultiTool>\data\memory\audits\          写入/遗忘/夜间维护的审计 JSONL
```

**夜间维护**是服务端的计划任务（`DSH-MultiTool Memory Nightly`，每天 **03:00**），不是插件做的：合并重复事实、给冲突双方标 `conflict`、衰减 30 天前的显著度、归档旧原文。插件不跑定时任务，DSH 关着也不影响它。

端口和环境变量：

| 项 | 默认 | 说明 |
|---|---|---|
| 端口 | `8767` | 只监听 `127.0.0.1`，不对外 |
| `DSH_MEMORY_URL` | — | 服务地址兜底（配置里没写时才用） |
| `DSH_USER_ID` | 未设置 | 当前用户 id（整数），决定写入归谁、检索看谁 |
| `DSH_COUNTERPART` | 未设置 | 当前对话对象（如 QQ 联系人），最长 60 字符 |

后两个由宿主在派生 DSH 进程时注入，插件每次调用都会重读——同一个进程里换了人也立即生效。

## 配置

这个插件没有 `config.json`，配置是**插件行的 `config` 字段**（包自带 `cordis.patch.yml` 里的默认值）：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `memoryUrl` | `http://127.0.0.1:8767` | 记忆服务根地址；结尾斜杠会被自动去掉 |

解析优先级：`config.memoryUrl` → `DSH_MEMORY_URL` → 内置默认值。

服务不在本机时，最省事的是设环境变量：

```powershell
$env:DSH_MEMORY_URL = "http://192.168.1.20:8767"
```

想写进 profile，就在 profile 的 `cordis.patch.yml` 里覆盖同一 id（`config` 是**整体替换**，字段要写全）：

```yaml
- id: dsh-memory
  config:
    memoryUrl: 'http://192.168.1.20:8767'
```

## 常见问题

### 1. 返回 `UNREACHABLE` / `TIMEOUT`

服务没起、端口不对，或地址写错。先探活：

```powershell
curl.exe -s http://127.0.0.1:8767/v1/health
```

有 JSON 就说明服务活着，问题在 `memoryUrl`；连不上就先把 `memory/server.js` 起起来。`TIMEOUT` 是 15 秒没响应，通常是服务卡住或数据库被锁。

### 2. 返回 `BAD_USER_ID`

`DSH_USER_ID` 必须是纯整数（`42` 可以，`user-42` 不行）。这是**故意 fail-closed** 的：配错时宁可这次调用失败，也不能静默退化成「共享记忆」，否则会突然读到别人的记忆。不设置这个变量才表示共享。

### 3. 明明记得，却搜不到

按可能性排：

1. 写入时的 `evidence` 没过校验（被 400 拒了，实际没存）；
2. 写入和检索用了不同的 `DSH_USER_ID`；
3. 设了 `DSH_COUNTERPART`，但写入时没带同一个值——检索只看「这个人 + 通用」；
4. 预算太小，把结果挤掉了：把 `max_items` / `max_tokens` 放大再试。

空结果本身不是错误。

### 4. 返回 `HTTP_401` / `HTTP_403`

插件**不带任何鉴权头**，它假设服务在回环地址上、无需认证。如果把记忆服务放到带登录的反向代理后面，要么把 `memoryUrl` 指回本机直连端口，要么让代理对 `127.0.0.1` 放行。401 不会自动重试。

### 5. 两个用户的记忆串了

先确认 `DSH_USER_ID` 注入到了**DSH 进程本身**的环境里——在另一个终端里 `set` 对已经在跑的 DSH 无效。再确认写入和检索走的是同一个 DSH（同一份 profile、同一套 env）。服务端审计日志里的 `userId` 是最快的核对点。

## 实现说明

- 单文件 `index.js`（约 250 行），零运行时依赖，只用 Node 内置 `fetch`；不 import 主项目任何文件，所以能单独装进任意 profile。
- 三个工具失败时**不抛异常**，返回 `{ ok:false, code, message?, hint? }`。`hint` 是给模型看的「下一步该干什么」，它才能自己改参数或提示你启动服务。
- 服务端是 SQLite + FTS5：写入走「证据门槛 → 去重/近似合并 → 实体链接 → 显著度」，检索走 FTS / 实体 / 时间窗三路候选再打分、按预算打包。`forget` 是软删 + 墓碑，检索立即不可见，`undo` 可恢复。
- 人设也在这个服务里：`GET /v1/persona` 返回 `block / version / traits`（speak 用它选音色，studio 用它选风格）。插件本身不读人设，需要人设的是那些服务。
- 想换后端：只要实现上面三条 POST，任何语言都行；插件不关心存储。

## License

MIT © 2026 lingbaojun233

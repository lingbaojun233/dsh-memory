# dsh-memory

把**记忆服务**注册成 DSH 原生工具：模型不用再先 `ls` 翻目录、拼 curl，而是像调用
`bash` 一样直接 `memory_search` / `memory_remember`。零运行时依赖，`index.js` 里只用
Node 内置的 `fetch`。

> Native DSH tools for a memory service — search, remember, forget. No dependencies.

## 它做什么

| 工具 | 作用 | 后端 |
| --- | --- | --- |
| `memory_search` | 按「条数 + token」双预算召回记忆，每条带证据定位 | `POST {memoryUrl}/v1/tools/memory_search` |
| `memory_remember` | 写入一条事件；没有 `evidence` 会被服务端拒收 | `POST {memoryUrl}/v1/tools/memory_remember` |
| `memory_forget` | 软删一条记忆；可审计、可用 `tombstone_id` 撤销 | `POST {memoryUrl}/v1/tools/memory_forget` |

工具执行失败**不抛异常**，而是返回 `{ ok: false, code, hint }` 这样的结构化 JSON——
模型看到 hint 才能自己恢复（改参数、提示你启动服务），而不是拿到一条读不懂的调用栈。

## 依赖

一个在跑的记忆服务，且实现下面三条 JSON 接口。默认端口 `8767`。

- 开箱即用：DSH-MultiTool 的 `memory` 模块（Windows 下 `memory\start-server.cmd`）。
  本文的接口契约就是按它写的。
- 自己实现也行，只要路径、请求体字段、返回 JSON 对齐即可（见下方「API 契约」）。
- 插件本身**不读数据库、不依赖任何其他仓库**，只发 HTTP。

### API 契约

三条都是 `POST` + `content-type: application/json`，响应是 JSON 对象。
`user_id` 只接受**整数或 null**；`null` 表示「共享记忆，不做用户隔离」。

```jsonc
// POST /v1/tools/memory_search
{ "query": "桥塌了", "user_id": 42, "counterpart": "张三",
  "budget": { "max_items": 8, "max_tokens": 1200 } }
// → { "ok": true, "items": [ { "id": "event:1", "text": "...", "evidence": "chat:g1#m2" } ], "used": {...} }

// POST /v1/tools/memory_remember
{ "content": "他说周五交稿", "evidence": "chat:g1#m9", "user_id": 42,
  "counterpart": "张三", "kind": "commitment", "speaker_name": "张三",
  "salience": 60, "channel": "chat" }
// → 201 { "ok": true, "stored": true, "eventId": 123 }

// POST /v1/tools/memory_forget
{ "id": "event:123", "reason": "user_request" }
// → { "ok": true, "tombstoneId": 7 }
```

## 安装

插件是标准 DSH bundle：`package.json` 里声明了 `dsh.bundle.patch`，装载时会插入
`cordis.patch.yml` 里那一行。以下三种方式任选其一。

### 方式 A：Plugin Manager（推荐）

在 DSH 的 Plugin Manager 里安装 `dsh-memory`，或让 agent 调用
`plugin_manager` 的 `install_bundle`。装完 bundle 后，插件行会自动出现。

### 方式 B：手工放进 profile 的 `node_modules`

```powershell
# 1) 把仓库放进 profile 的 node_modules（路径换成你自己的 profile）
$dst = "$env:USERPROFILE\.dsh\profiles\default\node_modules\dsh-memory"
robocopy . $dst /MIR

# 2) 在 profile/package.json 的 dsh.profile.bundles 里加上包名
#    "dsh": { "profile": { "bundles": ["dsh-memory"] } }
```

npm 发布之后也可以直接在 profile 目录里 `npm i dsh-memory`。

### 方式 C：直接写进 `cordis.yml`

profile 的 `cordis.yml` 本质是一个插件条目列表。原文件如果是空的 `[]`，整个换成：

```yaml
- id: dsh-memory
  name: dsh-memory
  config:
    memoryUrl: 'http://127.0.0.1:8767'
```

已有条目就追加一项（注意 `-` 对齐、YAML 缩进用空格）：

```yaml
- id: dsh-memory
  name: dsh-memory
  config:
    memoryUrl: 'http://127.0.0.1:8767'
```

> `name` 是**包名**，必须是 DSH 能解析到的模块；用方式 B 时要和 `node_modules` 下的目录名一致。

## 配置

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `memoryUrl` | `http://127.0.0.1:8767` | 记忆服务根地址，不要带结尾斜杠（带了也会被去掉） |

| 环境变量 | 作用 |
| --- | --- |
| `DSH_MEMORY_URL` | `memoryUrl` 的兜底值；配置里没写时才用它 |
| `DSH_USER_ID` | 当前用户 id（整数）。决定写入落在谁名下、检索只看「自己 + 共享」 |
| `DSH_COUNTERPART` | 当前对话对象（如 QQ 联系人），最长 60 字符。只召回「这个人 + 通用」的记忆 |

解析优先级：`config.memoryUrl` → `DSH_MEMORY_URL` → 内置默认值。

两个用户变量是**每次工具调用时现读**的，所以同一个 DSH 进程里换 env 立即生效；
但它们需要出现在 DSH 进程自己的环境里（由启动脚本或 io 注入），在别的终端里
`set DSH_USER_ID` 不会影响已经在跑的 DSH。

## 工具与参数 schema

### `memory_search`

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["query"],
  "properties": {
    "query": { "type": "string", "description": "Natural language or keywords" },
    "max_items": { "type": "integer", "minimum": 1, "maximum": 32, "description": "Default 8" },
    "max_tokens": { "type": "integer", "minimum": 50, "maximum": 4000, "description": "Default 1200" }
  }
}
```

### `memory_remember`

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["content", "evidence"],
  "properties": {
    "content": { "type": "string", "description": "What was said or done" },
    "evidence": { "type": "string", "description": "source:locator，例如 chat:g123#m456" },
    "kind": { "type": "string", "enum": ["msg", "video", "action", "commitment"] },
    "speaker": { "type": "string" },
    "salience": { "type": "integer", "minimum": 0, "maximum": 100 }
  }
}
```

### `memory_forget`

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["id"],
  "properties": {
    "id": { "type": "string", "description": "event:123 或 123" },
    "reason": { "type": "string" },
    "undo": { "type": "boolean" },
    "tombstone_id": { "type": "integer" }
  }
}
```

## 排错

### 1. `{ "ok": false, "code": "UNREACHABLE" }`

服务没起来、端口不对，或被防火墙拦了。

```powershell
# 用 Node 自带 fetch 探活，省掉 PowerShell 引号转义的坑
node -e "fetch('http://127.0.0.1:8767/v1/tools/memory_search',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:'test'})}).then(r=>r.text()).then(console.log)"
```

有返回就说明服务活着，问题在 `memoryUrl`；没返回就先把服务启动起来。
`code: "TIMEOUT"` 表示 15 秒没响应，通常是服务卡死或数据库被锁。

### 2. `{ "ok": false, "code": "HTTP_401" }` / `HTTP_403`

插件**不支持自定义鉴权头**，它假设服务在 localhost 上无需认证。如果你把记忆服务
放到带登录的反向代理后面，有两个选择：把 `memoryUrl` 指向本机直连端口，或者把代理
改成对 `127.0.0.1` 放行。返回 `401` 时插件不会自动重试。

### 3. `DSH_USER_ID` 不生效 / 记忆串号

- 变量必须是**纯整数**：`42` 可以，`user-42` 不行。非法值会让工具直接返回
  `{ "ok": false, "code": "BAD_USER_ID" }`，**不会**静默降级成共享记忆——配错时宁可
  调用失败，也不能突然读到别人的记忆。不设这个变量才表示共享记忆。
- 变量必须注入到 DSH **进程本身**的环境；在另一个终端里设置对已启动的进程无效。
- 写入时 `user_id` 和检索时不一致（例如写入用的 io 注入了 42、手动测试没注入），
  检索自然看不到。看服务端审计日志里的 `userId` 最快。
- `counterpart` 会缩小召回范围：设了它却查不到某个对话的记忆，先确认写入时也带了
  同一个 `counterpart`。

### 4. 检索结果为空

空结果是合法返回，不是错误。先放宽 `max_items` / `max_tokens`，再确认写入时
`evidence` 是否通过校验（无证据的写入会被 400 拒掉）。

### 5. 工具注册了但模型不用

工具表只在插件行**启用**后才注入。用 Plugin Manager 看该行的 `enabled` 与
`fiberPhase`；改完 `cordis.yml` 通常需要重载 profile（headless 模式每次调用都会重载）。

## 开发

```powershell
node --check index.js
```

没有测试依赖、没有构建步骤；改完直接重载插件即可。

## License

MIT © 2026 lingbaojun233

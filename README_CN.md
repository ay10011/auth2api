# auth2api

[English](./README.md)

一个轻量级 OAuth 转 API 代理，把你的 Claude（Anthropic）和 ChatGPT（OpenAI Codex）订阅变成可调用的 API，适配 Claude Code 与 OpenAI 兼容客户端。

auth2api 的定位很克制：

- 用自己的 Claude / ChatGPT 登录态
- 一个本地或自托管代理
- 按模型名自动路由到对应 provider

它并不试图做成大型多 provider 网关。如果你想要的是一个体积小、容易理解、方便自己改的代理，auth2api 就是为这个场景准备的。

## 功能特性

- **轻量优先**：代码量小、依赖和运行逻辑都尽量简单
- **双 provider 共存**：Claude OAuth 与 OpenAI Codex（ChatGPT）OAuth 同时支持，按 provider 独立维护账号池、cooldown、token 刷新与统计
- **OpenAI 兼容 API**：支持 `/v1/chat/completions`、`/v1/responses`、`/v1/models`
- **Claude 原生透传**：支持 `/v1/messages` 与 `/v1/messages/count_tokens`
- **适配 Claude Code**：兼容 `Authorization: Bearer` 和 `x-api-key`
- **覆盖核心能力**：支持流式、工具调用、图片与 reasoning，而不引入大型框架
- **账号健康管理**：内置 cooldown、重试、带并发锁的 token 刷新、`/admin/accounts` 快照
- **默认安全设置**：timing-safe API key 校验、每 IP 限流、仅允许 localhost 浏览器 CORS

## 运行要求

- Node.js 20+
- 一个 Claude 账号（推荐 Claude Max）

## 安装

```bash
git clone https://github.com/AmazingAng/auth2api
cd auth2api
npm install
npm run build
```

## 登录

auth2api 支持两种上游 provider：

- `anthropic`（默认）：Claude OAuth，对应 `claude-*` 模型。
- `codex`：OpenAI 的 "Sign in with ChatGPT" OAuth，直连官方 codex 后端 `https://chatgpt.com/backend-api/codex/responses`，对应 `gpt-5*`（含 `gpt-5-codex`）、`o\d*`、`codex-*` 模型。**需要 ChatGPT Plus 或 Pro 订阅** —— Free 账号也能登录，但首次调用会被后端拒绝(`model not supported`)。

通过 `--provider=` 选择登录哪个 provider，缺省为 `anthropic`。

### 自动模式（需要本地浏览器）

```bash
# Claude（默认）
node dist/index.js --login

# Codex（ChatGPT Plus/Pro）
node dist/index.js --login --provider=codex
```

程序会输出一个浏览器 URL。完成授权后，回调会自动处理。Anthropic 流程使用端口 `54545`，Codex 使用端口 `1455` —— 请确保两者都没被防火墙拦截。

### 手动模式（适合远程服务器）

```bash
node dist/index.js --login --manual
node dist/index.js --login --provider=codex --manual
```

在浏览器中打开输出的链接。授权完成后，浏览器会跳转到一个 `localhost` 地址，这个页面可能无法打开；请把地址栏中的完整 URL 复制回终端。

两个 provider 可以同时登录，token 文件会并存于 `auth-dir`（`claude-<email>.json` 与 `codex-<email>.json`），收到请求后按模型名自动路由到对应账号池。只登录其中一个也可以，未登录的 provider 不会出现在 `/v1/models` 中。

> **关于 Codex：** codex provider 中转的是你的 ChatGPT Plus/Pro 订阅额度。OpenAI 的 ToS 不允许通过第三方工具中转 ChatGPT 会话 —— 仅供本地个人自用。

## 启动服务

```bash
node dist/index.js
```

默认监听地址为 `http://127.0.0.1:8317`。首次启动时，如果 `config.yaml` 中没有配置 API key，会自动生成并写入该文件。

如果上游因为限流导致当前账号进入 cooldown，auth2api 会返回 `429 Rate limited on the configured account`，而不是通用的 `503`。

## 配置

复制 `config.example.yaml` 为 `config.yaml`，然后按需修改：

```yaml
host: ""          # 绑定地址，空字符串表示 127.0.0.1
port: 8317

auth-dir: "~/.auth2api"   # OAuth token 存储目录

api-keys:
  - "your-api-key-here"   # 客户端使用这个 key 访问代理

body-limit: "200mb"       # 最大 JSON 请求体大小，适合大上下文场景

cloaking:
  mode: "auto"            # auto | always | never
  strict-mode: false
  sensitive-words: []
  cache-user-id: false

debug: "off"            # off | errors | verbose
```

如果你要跑较长的 Claude Code 任务，也可以单独配置上游超时：

```yaml
timeouts:
  messages-ms: 120000
  stream-messages-ms: 600000
  count-tokens-ms: 30000
```

默认情况下，流式上游请求会允许持续 10 分钟后才会被 auth2api 主动中断。

默认请求体大小限制现在是 `200mb`，比之前固定的 `20mb` 更适合 Claude Code 的大上下文使用场景。

`debug` 现在支持三级日志：
- `off`：不输出额外调试日志
- `errors`：记录上游/网络失败信息和上游错误响应正文
- `verbose`：在 `errors` 基础上，再输出每个请求的方法、路径、状态码和耗时

## 使用方法

将任意 OpenAI 兼容客户端指向 `http://127.0.0.1:8317`：

```bash
curl http://127.0.0.1:8317/v1/chat/completions \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 1024
  }'
```

### 支持的模型

`GET /v1/models` 只列出已登录 provider 的模型。Codex 列表是从 `chatgpt.com/backend-api/codex/models` **实时拉取**(5 分钟缓存 + ETag),始终与你的账号实际可用模型一致。当前 ChatGPT 账号支持的 codex 模型集合:

| 模型 ID | Provider | 说明 |
|--------|----------|------|
| `claude-opus-4-7` | anthropic | Claude Opus 4.7 |
| `claude-opus-4-6` | anthropic | Claude Opus 4.6 |
| `claude-sonnet-4-6` | anthropic | Claude Sonnet 4.6 |
| `claude-haiku-4-5-20251001` | anthropic | Claude Haiku 4.5 |
| `claude-haiku-4-5` | anthropic | Claude Haiku 4.5 别名 |
| `gpt-5.5` | codex | GPT-5.5(reasoning model) |
| `gpt-5.4` | codex | GPT-5.4 |
| `gpt-5.4-mini` | codex | GPT-5.4 Mini |
| `gpt-5.3-codex` | codex | GPT-5.3(Codex 变体) |
| `gpt-5.2` | codex | GPT-5.2 |

auth2api 额外支持以下便捷别名：

- `opus` -> `claude-opus-4-7`
- `sonnet` -> `claude-sonnet-4-6`
- `haiku` -> `claude-haiku-4-5-20251001`

路由规则：根据模型名自动选择账号池。`claude-*` 与裸别名 `opus`/`sonnet`/`haiku` 走 Claude 账号；`gpt-5*`、`o\d`(`o3`、`o4-mini` 等)、`codex-*` 走 Codex 账号。其它型号(`gpt-3.5-*`、`gpt-4*` 等)两个后端都不支持，默认 fallback 到 anthropic。如果对应 provider 未登录，请求会返回 `503 no_account_for_provider`，错误信息中带有需要执行的 `--login` 命令。

### 端点 × Provider 支持矩阵

| Endpoint | anthropic | codex |
|----------|-----------|-------|
| `POST /v1/chat/completions` | ✅ | ❌（请用 `/v1/responses`，转换层在后续 PR 中实现） |
| `POST /v1/responses` | ✅ | ✅（直通） |
| `POST /v1/messages` | ✅ | ❌ |
| `POST /v1/messages/count_tokens` | ✅ | ❌（501） |

#### Codex `/v1/responses` 请求体要求

ChatGPT 的 codex 后端会拒绝缺少 `stream: true`、`store: false`、`instructions` 任一字段的请求。auth2api 在客户端没传时**会自动填默认值**,所以普通的 OpenAI Responses 客户端可以直接用。如果你显式传了某个字段(比如 `stream: false`),你的值会被保留,上游返回的 "Stream must be set to true" 错误会原样转发回去。

### 接口列表

| Endpoint | 说明 |
|----------|------|
| `POST /v1/chat/completions` | OpenAI 兼容聊天接口 |
| `POST /v1/responses` | OpenAI Responses API 兼容接口 |
| `POST /v1/messages` | Claude 原生消息透传 |
| `POST /v1/messages/count_tokens` | Claude token 计数 |
| `GET /v1/models` | 列出可用模型 |
| `GET /admin/accounts` | 查看账号健康状态（需要 API key） |
| `POST /admin/reload` | 从磁盘重新加载 token（需要 API key） |
| `GET /health` | 健康检查 |

## Docker

```bash
# 构建
docker build -t auth2api .

# 运行（挂载配置文件与 token 目录）
docker run -d \
  -p 8317:8317 \
  -v ~/.auth2api:/data \
  -v ./config.yaml:/config/config.yaml \
  auth2api
```

或者使用 docker-compose：

```bash
docker-compose up -d
```

## 与 Claude Code 配合使用

将 `ANTHROPIC_BASE_URL` 指向 auth2api：

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8317 \
ANTHROPIC_API_KEY=<your-api-key> \
claude
```

Claude Code 使用的是原生 `/v1/messages` 接口，auth2api 会直接透传。`Authorization: Bearer` 与 `x-api-key` 两种认证头都支持。

## 单账号模式

当前版本仅支持一个 Claude OAuth 账号。

- 再次执行 `--login` 时，如果还是同一个账号，会更新已保存的 token
- 如果本地已保存的是另一个账号，auth2api 会拒绝覆盖，并要求你先删除旧 token
- 如果 token 目录中存在多个 token 文件，auth2api 会直接报错并退出，直到你清理多余文件

## 管理状态

你可以通过 `/admin/accounts` 查看当前账号状态：

```bash
curl http://127.0.0.1:8317/admin/accounts \
  -H "Authorization: Bearer <your-api-key>"
```

响应结构(每个已登录 provider 一组):

```json
{
  "providers": {
    "anthropic": { "accounts": [...], "account_count": 1 },
    "codex":     { "accounts": [...], "account_count": 1 }
  },
  "generated_at": "2026-04-26T..."
}
```

每个账号 snapshot 包含:可用状态、cooldown 截止时间、失败计数、最近刷新时间、按账号聚合的 token 用量(其中 `totalReasoningOutputTokens` 是 reasoning 模型如 `gpt-5.5` 隐藏推理消耗的 token,不计入可见输出)。Codex 账号还会带 `planType`(从 OAuth `id_token` 提取的 `"plus"`/`"pro"`/`"free"` 等)。如果 refresh token 被永久作废(`refresh_token_reused`/`expired`/`invalidated`),账号会进入 24 小时终态冷却,`lastError` 中会提示需要重新执行 `--login --provider=<provider>`。

### 在不停机的情况下重新登录

服务运行中跑 `--login` 会写入新 token 文件并**自动通知运行中的服务**(POST `/admin/reload`),新 token 立刻生效,不必重启。对 codex provider 尤其重要:OpenAI 每次刷新都会轮转 refresh token,如果不重载,运行中的服务还在用旧的 refresh token,刷新会被后端识别为 `refresh_token_reused`,导致账号进入终态冷却。

你也可以手动触发重载(Windows、Docker、自动化脚本场景):

```bash
curl -X POST http://127.0.0.1:8317/admin/reload \
  -H "Authorization: Bearer <your-api-key>"
```

响应结构:

```json
{
  "reloaded": {
    "anthropic": { "added": [], "updated": ["alice@…"], "unchanged": [] },
    "codex":     { "added": [], "updated": [],          "unchanged": ["bob@…"] }
  },
  "generated_at": "2026-04-26T..."
}
```

重载语义为 **upsert**:磁盘上新出现的 token 文件会被添加到内存池;已有账号若 `access_token` 变化则替换(同时清掉 cooldown / `lastError`,但请求/用量统计保留);磁盘上消失的账号文件**不会**从内存中移除,以免误删 token 文件丢失历史统计——如确需移除,请重启服务。

`--login` 端的提示信息:

- `Notified running auth2api server to reload tokens.` —— 成功,服务已加载新 token。
- `(no auth2api server detected at <host>:<port> — token saved, will be loaded next start)` —— 连接被拒/超时。常见情形是当前没有服务在跑,不算错误。
- `auth2api server is running but rejected the reload (HTTP 401/403). …restart the server to pick up the new token.` —— 可执行行动:把 config 改回原 api-key,或重启服务让其加载新 key。

## Smoke 测试

仓库内置了一套最小自动化 smoke test，并使用 mocked upstream response，因此不会调用真实 Claude 服务：

```bash
npm run test:smoke
```

## 致谢

- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
- [sub2api](https://github.com/Wei-Shaw/sub2api)

## License

MIT

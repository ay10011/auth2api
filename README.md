# auth2api

[中文](./README_CN.md)

A lightweight OAuth-to-API proxy that turns your Claude (Anthropic) and ChatGPT (OpenAI Codex) subscriptions into usable API endpoints for Claude Code and OpenAI-compatible clients.

auth2api is intentionally small and focused:

- bring your own Claude / ChatGPT login
- one local or self-hosted proxy
- automatic per-provider routing by model name

It is not trying to be a large multi-provider gateway. If you want a compact, understandable proxy that is easy to run and modify, auth2api is built for that use case.

## Features

- **Lightweight by design** — small codebase, minimal moving parts
- **Two providers, one proxy** — Claude OAuth and OpenAI Codex (ChatGPT) OAuth coexist; per-provider account pools, cooldown, refresh, and stats
- **OpenAI-compatible API** — supports `/v1/chat/completions`, `/v1/responses`, and `/v1/models`
- **Claude native passthrough** — supports `/v1/messages` and `/v1/messages/count_tokens`
- **Claude Code friendly** — works with both `Authorization: Bearer` and `x-api-key`
- **Streaming, tools, images, and reasoning** — covers the main usage patterns without a large framework
- **Per-account health handling** — cooldown, retry, token refresh (with concurrency lock), and `/admin/accounts` snapshot
- **Basic safety defaults** — timing-safe API key validation, per-IP rate limiting, localhost-only browser CORS

## Requirements

- Node.js 20+
- A Claude account (Claude Max subscription recommended)

## Installation

```bash
git clone https://github.com/AmazingAng/auth2api
cd auth2api
npm install
npm run build
```

## Login

auth2api supports two upstream providers:

- `anthropic` — Claude OAuth (default). Used for `claude-*` models.
- `codex` — OpenAI's "Sign in with ChatGPT" OAuth, talking to the official codex backend at `https://chatgpt.com/backend-api/codex/responses`. Used for `gpt-5*` (incl. `gpt-5-codex`), `o\d*`, and `codex-*` models. Requires a **ChatGPT Plus or Pro** subscription — Free accounts authenticate but the first call fails with `model not supported`.

Pick the provider with `--provider=`. Default is `anthropic`.

### Auto mode (requires local browser)

```bash
# Claude (default)
node dist/index.js --login

# Codex (ChatGPT Plus/Pro)
node dist/index.js --login --provider=codex
```

Opens a browser URL. After authorizing, the callback is handled automatically. The Anthropic flow uses port `54545`; the Codex flow uses port `1455` — make sure neither is blocked by your firewall.

### Manual mode (for remote servers)

```bash
node dist/index.js --login --manual
node dist/index.js --login --provider=codex --manual
```

Open the printed URL in your browser. After authorizing, your browser will redirect to a `localhost` URL that fails to load — copy the full URL from the address bar and paste it back into the terminal.

You can log in to both providers; auth2api stores tokens side-by-side in `auth-dir` (`claude-<email>.json` and `codex-<email>.json`) and routes inbound requests to the matching pool by model name. Logging in to only one provider is fine — the other simply has no advertised models.

> **Note on Codex:** The codex provider relays your ChatGPT Plus/Pro subscription quota. OpenAI's ToS does not officially permit relaying ChatGPT sessions through third-party tools — use this for your own personal local consumption only.

## Starting the server

```bash
node dist/index.js
```

The server starts on `http://127.0.0.1:8317` by default. On first run, an API key is auto-generated and saved to `config.yaml`.

If the configured Claude account is temporarily cooled down after upstream rate limiting, auth2api now returns `429 Rate limited on the configured account` instead of a generic `503`.

## Configuration

Copy `config.example.yaml` to `config.yaml` and edit as needed:

```yaml
host: ""          # bind address, empty = 127.0.0.1
port: 8317

auth-dir: "~/.auth2api"   # where OAuth tokens are stored

api-keys:
  - "your-api-key-here"   # clients use this to authenticate

body-limit: "200mb"       # maximum JSON request body size, useful for large-context usage

cloaking:
  mode: "auto"            # auto | always | never
  strict-mode: false
  sensitive-words: []
  cache-user-id: false

debug: "off"            # off | errors | verbose
```

Timeouts can also be configured if you run long Claude Code tasks:

```yaml
timeouts:
  messages-ms: 120000
  stream-messages-ms: 600000
  count-tokens-ms: 30000
```

By default, streaming upstream requests are allowed to run for 10 minutes before auth2api aborts them.

The default request body limit is `200mb`, which is more suitable for large Claude Code contexts than the previous fixed `20mb`.

`debug` now supports three levels:
- `off`: no extra logs
- `errors`: log upstream/network failures and upstream error bodies
- `verbose`: include `errors` logs plus per-request method, path, status, and duration

## Usage

Use any OpenAI-compatible client pointed at `http://127.0.0.1:8317`:

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

### Available models

`GET /v1/models` lists only models for providers you've actually logged in to. The codex list is **fetched live** from `chatgpt.com/backend-api/codex/models` (cached 5 minutes, ETag-aware) so it always matches what your account can actually serve. The current ChatGPT-account-supported set at the time of writing:

| Model ID | Provider | Description |
|----------|----------|-------------|
| `claude-opus-4-7` | anthropic | Claude Opus 4.7 |
| `claude-opus-4-6` | anthropic | Claude Opus 4.6 |
| `claude-sonnet-4-6` | anthropic | Claude Sonnet 4.6 |
| `claude-haiku-4-5-20251001` | anthropic | Claude Haiku 4.5 |
| `claude-haiku-4-5` | anthropic | Alias for Claude Haiku 4.5 |
| `gpt-5.5` | codex | GPT-5.5 (reasoning model) |
| `gpt-5.4` | codex | GPT-5.4 |
| `gpt-5.4-mini` | codex | GPT-5.4 Mini |
| `gpt-5.3-codex` | codex | GPT-5.3 (Codex variant) |
| `gpt-5.2` | codex | GPT-5.2 |

Short convenience aliases accepted by auth2api:

- `opus` -> `claude-opus-4-7`
- `sonnet` -> `claude-sonnet-4-6`
- `haiku` -> `claude-haiku-4-5-20251001`

Routing: requests are dispatched to the matching pool by model name. `claude-*` and the bare aliases (`opus`/`sonnet`/`haiku`) hit your Claude account; `gpt-5*`, `o\d` (`o3`, `o4-mini`, …), and `codex-*` hit your Codex account. Other model families (`gpt-3.5-*`, `gpt-4*`, …) are not served by either backend and route to anthropic by default. If you haven't logged into the matching provider, the request returns `503 no_account_for_provider` with the exact `--login` command to fix it.

### Endpoint × provider support matrix

| Endpoint | anthropic | codex |
|----------|-----------|-------|
| `POST /v1/chat/completions` | ✅ | ❌ (use `/v1/responses` — translation pending) |
| `POST /v1/responses` | ✅ | ✅ (passthrough) |
| `POST /v1/messages` | ✅ | ❌ |
| `POST /v1/messages/count_tokens` | ✅ | ❌ (501) |

#### Codex `/v1/responses` body requirements

The ChatGPT codex backend rejects requests that don't include `stream: true`, `store: false`, and `instructions`. auth2api **auto-fills these defaults** when the client doesn't send them, so off-the-shelf OpenAI Responses clients just work. If you set any of these explicitly (e.g. `stream: false`), your value is preserved and the upstream's "Stream must be set to true" error is forwarded as-is.

### Endpoints

| Endpoint | Description |
|----------|-------------|
| `POST /v1/chat/completions` | OpenAI-compatible chat |
| `POST /v1/responses` | OpenAI Responses API compatibility |
| `POST /v1/messages` | Claude native passthrough |
| `POST /v1/messages/count_tokens` | Claude token counting |
| `GET /v1/models` | List available models |
| `GET /admin/accounts` | Account health/status (API key required) |
| `POST /admin/reload` | Reload tokens from disk (API key required) |
| `GET /health` | Health check |

## Docker

```bash
# Build
docker build -t auth2api .

# Run (mount your config and token directory)
docker run -d \
  -p 8317:8317 \
  -v ~/.auth2api:/data \
  -v ./config.yaml:/config/config.yaml \
  auth2api
```

Or with docker-compose:

```bash
docker-compose up -d
```

## Use with Claude Code

Set `ANTHROPIC_BASE_URL` to point Claude Code at auth2api:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8317 \
ANTHROPIC_API_KEY=<your-api-key> \
claude
```

Claude Code uses the native `/v1/messages` endpoint which auth2api passes through directly. Both `Authorization: Bearer` and `x-api-key` authentication headers are supported.

## Single-account mode

This proxy supports exactly one Claude OAuth account at a time.

- Running `--login` again refreshes the stored token for the same account.
- If a different account is already stored, auth2api refuses to overwrite it and asks you to remove the existing token first.
- If more than one token file exists in the auth directory, auth2api exits with an error until you clean up the extra files.

## Admin status

Use `/admin/accounts` with your configured API key to inspect the current account state:

```bash
curl http://127.0.0.1:8317/admin/accounts \
  -H "Authorization: Bearer <your-api-key>"
```

Response shape (one entry per logged-in provider):

```json
{
  "providers": {
    "anthropic": { "accounts": [...], "account_count": 1 },
    "codex":     { "accounts": [...], "account_count": 1 }
  },
  "generated_at": "2026-04-26T..."
}
```

Each account snapshot carries availability, cooldown, failure counters, last refresh time, and per-account token usage including `totalReasoningOutputTokens` (reasoning models like `gpt-5.5` consume hidden reasoning tokens that aren't part of the visible output). Codex accounts also carry `planType` (e.g. `"plus"` / `"pro"` / `"free"`) extracted from the OAuth `id_token`. If a refresh token was permanently invalidated (`refresh_token_reused`/`expired`/`invalidated`), the account enters a 24-hour terminal cooldown with `lastError` set to a message pointing at `--login --provider=<provider>` for re-authorization.

### Re-authenticating without restart

Running `--login` while the server is up writes a new token file and **automatically notifies the running server** (via `POST /admin/reload`) so the new token takes effect immediately — no restart needed. This is especially important for the codex provider: OpenAI rotates the refresh token on every refresh, so leaving the server running with a stale refresh token while you re-auth would otherwise put the account into a `refresh_token_reused` terminal cooldown.

You can also trigger a reload manually (e.g. on Windows, in containers, or after a `kill -USR1` workflow) by posting to the endpoint:

```bash
curl -X POST http://127.0.0.1:8317/admin/reload \
  -H "Authorization: Bearer <your-api-key>"
```

Response shape:

```json
{
  "reloaded": {
    "anthropic": { "added": [], "updated": ["alice@…"], "unchanged": [] },
    "codex":     { "added": [], "updated": [],          "unchanged": ["bob@…"] }
  },
  "generated_at": "2026-04-26T..."
}
```

Reload semantics are **upsert only**: new token files on disk are added to the in-memory pool, existing accounts whose `access_token` changed are updated (and any cooldown / `lastError` is cleared, but request/usage stats are preserved), and accounts that no longer exist on disk are kept in memory until the next restart (so historical stats aren't dropped if a token file is accidentally removed).

Failure modes of the auto-notify (printed by `--login`):

- `Notified running auth2api server to reload tokens.` — success, server picked up the new token.
- `(no auth2api server detected at <host>:<port> — token saved, will be loaded next start)` — connection refused / timeout. Common case when no server is running; not an error.
- `auth2api server is running but rejected the reload (HTTP 401/403). The api-keys in config.yaml may differ from the running server's; restart the server to pick up the new token.` — actionable: either edit your config back to match, or restart so the server picks up the new key set.

## Smoke tests

A minimal automated smoke test suite is included and uses mocked upstream responses, so it does not call the real Claude service:

```bash
npm run test:smoke
```

## Inspired by

- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
- [sub2api](https://github.com/Wei-Shaw/sub2api)

## License

MIT

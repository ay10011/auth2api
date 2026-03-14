# auth2api

A lightweight proxy that converts Claude OAuth tokens into an OpenAI-compatible API, allowing you to use Claude models with any OpenAI-compatible client or directly with Claude Code.

## Features

- **OpenAI-compatible API** — drop-in replacement for OpenAI clients (`/v1/chat/completions`, `/v1/responses`, `/v1/models`)
- **Claude native passthrough** — direct `/v1/messages` and `/v1/messages/count_tokens` endpoints
- **Streaming support** — SSE streaming for both OpenAI and Claude native formats
- **Thinking/reasoning** — maps `reasoning_effort` to Claude's extended thinking
- **Tool calls** — full support for function calling, streaming and non-streaming
- **Image support** — passes image_url content to Claude's vision API
- **Single-account mode** — one Claude OAuth account with cooldown, refresh, and health tracking
- **Auto token refresh** — refreshes OAuth tokens before expiry
- **Claude Code compatible** — accepts both `Authorization: Bearer` and `x-api-key` headers
- **Admin status endpoint** — inspect account health via `/admin/accounts`
- **Security** — timing-safe API key validation, rate limiting (60 req/min per IP), localhost-only CORS

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

### Auto mode (requires local browser)

```bash
node dist/index.js --login
```

Opens a browser URL. After authorizing, the callback is handled automatically.

### Manual mode (for remote servers)

```bash
node dist/index.js --login --manual
```

Open the printed URL in your browser. After authorizing, your browser will redirect to a `localhost` URL that fails to load — copy the full URL from the address bar and paste it back into the terminal.

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

cloaking:
  mode: "auto"            # auto | always | never
  strict-mode: false
  sensitive-words: []
  cache-user-id: false

debug: false
```

## Usage

Use any OpenAI-compatible client pointed at `http://127.0.0.1:8317`:

```bash
curl http://127.0.0.1:8317/v1/chat/completions \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5-20250929",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 1024
  }'
```

### Available models

| Model ID | Description |
|----------|-------------|
| `claude-sonnet-4-5-20250929` | Claude Sonnet 4.5 |
| `claude-haiku-4-5-20251001` | Claude Haiku 4.5 |
| `claude-opus-4-1-20250805` | Claude Opus 4.1 |
| `claude-opus-4-20250514` | Claude Opus 4 |
| `claude-sonnet-4-20250514` | Claude Sonnet 4 |
| `claude-3-7-sonnet-20250219` | Claude 3.7 Sonnet |
| `claude-3-5-haiku-20241022` | Claude 3.5 Haiku |

### Endpoints

| Endpoint | Description |
|----------|-------------|
| `POST /v1/chat/completions` | OpenAI-compatible chat |
| `POST /v1/responses` | OpenAI Responses API compatibility |
| `POST /v1/messages` | Claude native passthrough |
| `POST /v1/messages/count_tokens` | Claude token counting |
| `GET /v1/models` | List available models |
| `GET /admin/accounts` | Account health/status (API key required) |
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

The response includes account availability, cooldown, failure counters, last refresh time, and basic request statistics.

## Smoke tests

A minimal automated smoke test suite is included and uses mocked upstream responses, so it does not call the real Claude service:

```bash
npm run test:smoke
```

## License

MIT

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { AddressInfo } from "node:net";
import { createServer as createHttpServer } from "node:http";

import { AccountManager } from "../src/accounts/manager";
import { Config, loadConfig } from "../src/config";
import { createServer } from "../src/server";
import { saveToken } from "../src/auth/token-storage";
import { TokenData } from "../src/auth/types";
import { buildRegistry, ProviderRegistry } from "../src/providers/registry";
import { refreshTokensWithRetry } from "../src/auth/oauth";

const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";

function makeConfig(authDir: string): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    "auth-dir": authDir,
    "api-keys": new Set(["test-key"]),
    "body-limit": "200mb",
    cloaking: {
      "cli-version": "2.1.88",
      entrypoint: "cli",
    },
    timeouts: {
      "messages-ms": 120000,
      "stream-messages-ms": 600000,
      "count-tokens-ms": 30000,
    },
    debug: "off",
  };
}

function makeToken(overrides: Partial<TokenData> = {}): TokenData {
  return {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    email: "test@example.com",
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    accountUuid: "test-uuid",
    provider: "anthropic",
    ...overrides,
  };
}

function makeManager(authDir: string, tokens: TokenData[]): AccountManager {
  for (const token of tokens) {
    saveToken(authDir, token);
  }
  const manager = new AccountManager(authDir, {
    provider: "anthropic",
    refresh: refreshTokensWithRetry,
  });
  manager.load();
  return manager;
}

function makeRegistry(
  authDir: string,
  manager: AccountManager,
): ProviderRegistry {
  // Build the real registry, then swap the anthropic manager for the test one
  // so the existing tests can introspect/control it.
  const registry = buildRegistry(authDir);
  const anthropic = registry.get("anthropic");
  // Replace the manager with the pre-populated test instance.
  (anthropic as { manager: AccountManager }).manager = manager;
  return registry;
}

async function startApp(
  config: Config,
  manager: AccountManager,
): Promise<http.Server> {
  const registry = makeRegistry(config["auth-dir"], manager);
  const app = createServer(config, registry);
  const server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

async function stopApp(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function requestJson(options: {
  server: http.Server;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
  const address = serverAddress(options.server);
  const payload = options.body ? JSON.stringify(options.body) : undefined;

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: address.port,
        method: options.method,
        path: options.path,
        headers: {
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload).toString(),
              }
            : {}),
          ...(options.headers || {}),
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode || 0,
            body: data ? JSON.parse(data) : null,
            headers: res.headers,
          });
        });
      },
    );

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function serverAddress(server: http.Server): AddressInfo {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Server is not listening on a TCP port");
  }
  return address;
}

function withMockedFetch(
  mock: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>,
): () => void {
  const originalFetch = global.fetch;
  global.fetch = mock as typeof fetch;
  return () => {
    global.fetch = originalFetch;
  };
}

test("accepts x-api-key auth and serves models/admin state", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  const manager = makeManager(authDir, [makeToken()]);
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const modelsResp = await requestJson({
    server,
    method: "GET",
    path: "/v1/models",
    headers: { "x-api-key": "test-key" },
  });

  assert.equal(modelsResp.status, 200);
  assert.ok(Array.isArray(modelsResp.body.data));
  assert.ok(modelsResp.body.data.length > 0);

  const adminResp = await requestJson({
    server,
    method: "GET",
    path: "/admin/accounts",
    headers: { "x-api-key": "test-key" },
  });

  assert.equal(adminResp.status, 200);
  assert.equal(adminResp.body.providers.anthropic.account_count, 1);
  assert.equal(
    adminResp.body.providers.anthropic.accounts[0].email,
    "test@example.com",
  );
  assert.equal(adminResp.body.providers.codex.account_count, 0);
});

test("proxies a non-stream chat completion through Claude OAuth token", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  const manager = makeManager(authDir, [makeToken()]);
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    assert.equal(url, "https://api.anthropic.com/v1/messages?beta=true");
    assert.equal(init?.method, "POST");
    assert.equal(
      init?.headers && (init.headers as Record<string, string>).Authorization,
      "Bearer access-token",
    );

    return new Response(
      JSON.stringify({
        id: "msg_1",
        content: [{ type: "text", text: "hello from claude" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 12, output_tokens: 5 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    },
  });

  assert.equal(resp.status, 200);
  assert.equal(resp.body.object, "chat.completion");
  assert.equal(resp.body.choices[0].message.content, "hello from claude");
  assert.equal(resp.body.usage.total_tokens, 17);
});

test("refreshes the OAuth token after an upstream 401 and retries successfully", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  const manager = makeManager(authDir, [makeToken()]);
  const calls: string[] = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    calls.push(url);

    if (url === "https://api.anthropic.com/v1/messages?beta=true") {
      const authHeader = (init?.headers as Record<string, string>)
        .Authorization;
      if (authHeader === "Bearer access-token") {
        return new Response("unauthorized", { status: 401 });
      }
      if (authHeader === "Bearer refreshed-access-token") {
        return new Response(
          JSON.stringify({
            id: "msg_after_refresh",
            content: [{ type: "text", text: "refreshed ok" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 3, output_tokens: 2 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    if (url === TOKEN_URL) {
      return new Response(
        JSON.stringify({
          access_token: "refreshed-access-token",
          refresh_token: "refreshed-refresh-token",
          expires_in: 3600,
          account: { email_address: "test@example.com" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    throw new Error(`Unexpected fetch to ${url}`);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "refresh me" }],
      stream: false,
    },
  });

  assert.equal(resp.status, 200);
  assert.equal(resp.body.choices[0].message.content, "refreshed ok");
  assert.deepEqual(calls, [
    "https://api.anthropic.com/v1/messages?beta=true",
    TOKEN_URL,
    "https://api.anthropic.com/v1/messages?beta=true",
  ]);

  const adminResp = await requestJson({
    server,
    method: "GET",
    path: "/admin/accounts",
    headers: { Authorization: "Bearer test-key" },
  });

  assert.equal(adminResp.status, 200);
  const anthAccounts = adminResp.body.providers.anthropic.accounts;
  assert.equal(anthAccounts[0].lastRefreshAt !== null, true);
  assert.equal(anthAccounts[0].totalSuccesses, 1);
});

test("does not double-refresh when the second request also 401s (refresh-token-rotation safety)", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  const manager = makeManager(authDir, [makeToken()]);
  const calls: string[] = [];
  let refreshCalls = 0;
  const restoreFetch = withMockedFetch(async (input) => {
    const url = String(input);
    calls.push(url);
    // Upstream is broken — every call returns 401 regardless of token.
    if (url === "https://api.anthropic.com/v1/messages?beta=true") {
      return new Response("unauthorized", { status: 401 });
    }
    if (url === TOKEN_URL) {
      refreshCalls++;
      return new Response(
        JSON.stringify({
          access_token: `refreshed-${refreshCalls}`,
          refresh_token: `rotated-${refreshCalls}`,
          expires_in: 3600,
          account: { email_address: "test@example.com" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "fail me" }],
      stream: false,
    },
  });

  // Final response should be the upstream 401 we couldn't recover from.
  assert.equal(resp.status, 401);
  // Critical: refresh is called exactly ONCE, not on every 401. Otherwise we
  // would burn rotated refresh tokens and could trigger a refresh_token_reused
  // failure on the next legitimate refresh.
  assert.equal(
    refreshCalls,
    1,
    `expected one refresh, saw ${refreshCalls}; calls: ${JSON.stringify(calls)}`,
  );
});

test("returns rate limited when the configured account is cooled down", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  const manager = makeManager(authDir, [makeToken()]);
  manager.recordFailure(
    "test@example.com",
    "rate_limit",
    "forced for smoke test",
  );
  const restoreFetch = withMockedFetch(async () => {
    throw new Error(
      "Upstream should not be called while the configured account is cooled down",
    );
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hello" }],
    },
  });

  assert.equal(resp.status, 429);
  assert.equal(
    resp.body.error.message,
    "Rate limited on the configured account",
  );
  assert.equal(typeof resp.headers["retry-after"], "string");
});

test("returns 503 when account requires re-authentication", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  const manager = makeManager(authDir, [makeToken()]);
  manager.recordFailure("test@example.com", "auth", "forced");
  const restoreFetch = withMockedFetch(async () => {
    throw new Error("should not be called");
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hi" }],
    },
  });

  assert.equal(resp.status, 503);
  assert.equal(
    resp.body.error.message,
    "Configured account requires re-authentication",
  );
});

test("returns 503 when account is forbidden", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  const manager = makeManager(authDir, [makeToken()]);
  manager.recordFailure("test@example.com", "forbidden", "forced");
  const restoreFetch = withMockedFetch(async () => {
    throw new Error("should not be called");
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hi" }],
    },
  });

  assert.equal(resp.status, 503);
  assert.equal(resp.body.error.message, "Configured account is forbidden");
});

test("returns 503 when upstream server is unavailable", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  const manager = makeManager(authDir, [makeToken()]);
  manager.recordFailure("test@example.com", "server", "forced");
  const restoreFetch = withMockedFetch(async () => {
    throw new Error("should not be called");
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hi" }],
    },
  });

  assert.equal(resp.status, 503);
  assert.equal(
    resp.body.error.message,
    "Upstream server temporarily unavailable",
  );
});

test("returns 503 when upstream network is unavailable", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  const manager = makeManager(authDir, [makeToken()]);
  manager.recordFailure("test@example.com", "network", "forced");
  const restoreFetch = withMockedFetch(async () => {
    throw new Error("should not be called");
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hi" }],
    },
  });

  assert.equal(resp.status, 503);
  assert.equal(
    resp.body.error.message,
    "Upstream network temporarily unavailable",
  );
});

test("loads multiple accounts successfully", (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  t.after(() => {
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  saveToken(
    authDir,
    makeToken({ email: "first@example.com", accessToken: "first-access" }),
  );
  saveToken(
    authDir,
    makeToken({ email: "second@example.com", accessToken: "second-access" }),
  );

  const manager = new AccountManager(authDir, {
    provider: "anthropic",
    refresh: refreshTokensWithRetry,
  });
  manager.load();
  assert.equal(manager.accountCount, 2);
});

test("sticky selection keeps using the same available account", (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  t.after(() => {
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const manager = makeManager(authDir, [
    makeToken({ email: "a@example.com", accessToken: "token-a" }),
    makeToken({ email: "b@example.com", accessToken: "token-b" }),
    makeToken({ email: "c@example.com", accessToken: "token-c" }),
  ]);

  const first = manager.getNextAccount();
  assert.ok(first.account);
  assert.equal(first.account.token.email, "a@example.com");

  const second = manager.getNextAccount();
  assert.ok(second.account);
  assert.equal(second.account.token.email, "a@example.com");

  const third = manager.getNextAccount();
  assert.ok(third.account);
  assert.equal(third.account.token.email, "a@example.com");
});

test("sticky selection switches when the current account is cooled down", (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  t.after(() => {
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const manager = makeManager(authDir, [
    makeToken({ email: "a@example.com", accessToken: "token-a" }),
    makeToken({ email: "b@example.com", accessToken: "token-b" }),
    makeToken({ email: "c@example.com", accessToken: "token-c" }),
  ]);

  const first = manager.getNextAccount();
  assert.ok(first.account);
  assert.equal(first.account.token.email, "a@example.com");

  manager.recordFailure("a@example.com", "rate_limit", "test");

  const second = manager.getNextAccount();
  assert.ok(second.account);
  assert.equal(second.account.token.email, "b@example.com");

  const third = manager.getNextAccount();
  assert.ok(third.account);
  assert.equal(third.account.token.email, "b@example.com");
});

test("returns failure info when all accounts are cooled down", (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  t.after(() => {
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const manager = makeManager(authDir, [
    makeToken({ email: "a@example.com", accessToken: "token-a" }),
    makeToken({ email: "b@example.com", accessToken: "token-b" }),
  ]);

  manager.recordFailure("a@example.com", "rate_limit", "test");
  manager.recordFailure("b@example.com", "rate_limit", "test");

  const result = manager.getNextAccount();
  if (result.account !== null) {
    assert.fail("Expected null account");
  }
  assert.equal(result.failureKind, "rate_limit");
  assert.ok((result.retryAfterMs ?? 0) > 0);
});

test("prefers recoverable failure over terminal when all accounts down", (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  t.after(() => {
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const manager = makeManager(authDir, [
    makeToken({ email: "a@example.com", accessToken: "token-a" }),
    makeToken({ email: "b@example.com", accessToken: "token-b" }),
  ]);

  manager.recordFailure("a@example.com", "auth", "test");
  manager.recordFailure("b@example.com", "rate_limit", "test");

  const result = manager.getNextAccount();
  if (result.account !== null) {
    assert.fail("Expected null account");
  }
  assert.equal(result.failureKind, "rate_limit");
  assert.ok((result.retryAfterMs ?? 0) > 0);
});

test("multi-account admin endpoint shows all accounts", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  const manager = makeManager(authDir, [
    makeToken({ email: "a@example.com", accessToken: "token-a" }),
    makeToken({ email: "b@example.com", accessToken: "token-b" }),
  ]);
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "GET",
    path: "/admin/accounts",
    headers: { "x-api-key": "test-key" },
  });

  assert.equal(resp.status, 200);
  assert.equal(resp.body.providers.anthropic.account_count, 2);
  const emails = resp.body.providers.anthropic.accounts
    .map((a: any) => a.email)
    .sort();
  assert.deepEqual(emails, ["a@example.com", "b@example.com"]);
});

test("multi-account proxies requests using sticky account until failover", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  const manager = makeManager(authDir, [
    makeToken({ email: "a@example.com", accessToken: "token-a" }),
    makeToken({ email: "b@example.com", accessToken: "token-b" }),
  ]);

  const usedTokens: string[] = [];
  const restoreFetch = withMockedFetch(async (_input, init) => {
    const authHeader = (init?.headers as Record<string, string>).Authorization;
    usedTokens.push(authHeader.replace("Bearer ", ""));

    return new Response(
      JSON.stringify({
        id: "msg_1",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });

  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  // First request
  await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "1" }],
      stream: false,
    },
  });

  // Second request
  await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "2" }],
      stream: false,
    },
  });

  // Third request (wraps around)
  await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "3" }],
      stream: false,
    },
  });

  assert.deepEqual(usedTokens, ["token-a", "token-a", "token-a"]);
});

test("multi-account falls back to next account on rate limit", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  const manager = makeManager(authDir, [
    makeToken({ email: "a@example.com", accessToken: "token-a" }),
    makeToken({ email: "b@example.com", accessToken: "token-b" }),
  ]);

  const usedTokens: string[] = [];
  const restoreFetch = withMockedFetch(async (_input, init) => {
    const authHeader = (init?.headers as Record<string, string>).Authorization;
    const token = authHeader.replace("Bearer ", "");
    usedTokens.push(token);

    if (token === "token-a") {
      return new Response("rate limited", { status: 429 });
    }
    return new Response(
      JSON.stringify({
        id: "msg_1",
        content: [{ type: "text", text: "from b" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });

  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    },
  });

  assert.equal(resp.status, 200);
  assert.equal(resp.body.choices[0].message.content, "from b");
  // First attempt used token-a (got 429), retry used token-b (success)
  assert.equal(usedTokens[0], "token-a");
  assert.ok(usedTokens.includes("token-b"));
});

// ── loadConfig: YAML api-keys array → Set ──

test("loadConfig converts YAML api-keys array to Set", () => {
  const configPath = path.join(os.tmpdir(), `auth2api-test-${Date.now()}.yaml`);
  fs.writeFileSync(
    configPath,
    [
      'host: "127.0.0.1"',
      "port: 9999",
      'auth-dir: "~/.auth2api"',
      "api-keys:",
      '  - "sk-key-one"',
      '  - "sk-key-two"',
      '  - "sk-key-three"',
      'body-limit: "100mb"',
      'debug: "off"',
    ].join("\n"),
  );

  try {
    const config = loadConfig(configPath);
    assert.ok(config["api-keys"] instanceof Set);
    assert.equal(config["api-keys"].size, 3);
    assert.ok(config["api-keys"].has("sk-key-one"));
    assert.ok(config["api-keys"].has("sk-key-two"));
    assert.ok(config["api-keys"].has("sk-key-three"));
    assert.ok(!config["api-keys"].has("sk-missing"));
  } finally {
    fs.unlinkSync(configPath);
  }
});

test("POST /admin/reload reloads token from disk; subsequent request uses new bearer", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  // Existing in-memory token = "old-access". Disk will be rewritten to "new-access" mid-test.
  const manager = makeManager(authDir, [makeToken({ accessToken: "old-access" })]);

  const calls: { url: string; auth: string }[] = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    const auth =
      ((init?.headers as Record<string, string> | undefined)?.Authorization) ||
      "";
    calls.push({ url, auth });
    if (url.startsWith("https://api.anthropic.com/v1/messages")) {
      // Backend only accepts the new token.
      if (auth === "Bearer new-access") {
        return new Response(
          JSON.stringify({
            id: "msg_ok",
            content: [{ type: "text", text: "hello after reload" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("unauthorized", { status: 401 });
    }
    if (url === TOKEN_URL) {
      // If the manager tries to refresh while we're racing, return a fresh
      // unrelated token so the test isolates the reload path.
      return new Response(
        JSON.stringify({
          access_token: "refresh-noise",
          refresh_token: "rt",
          expires_in: 3600,
          account: { email_address: "test@example.com" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });

  const server = await startApp(makeConfig(authDir), manager);
  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  // Simulate `--login` writing a new token to disk while server is up.
  saveToken(authDir, makeToken({ accessToken: "new-access" }));

  // Trigger reload via the new endpoint.
  const reloadResp = await requestJson({
    server,
    method: "POST",
    path: "/admin/reload",
    headers: { Authorization: "Bearer test-key" },
  });
  assert.equal(reloadResp.status, 200);
  assert.deepEqual(reloadResp.body.reloaded.anthropic.updated, [
    "test@example.com",
  ]);
  assert.deepEqual(reloadResp.body.reloaded.anthropic.added, []);

  // Subsequent request should use the new bearer.
  const chatResp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    },
  });
  assert.equal(chatResp.status, 200);
  assert.equal(
    chatResp.body.choices[0].message.content,
    "hello after reload",
  );
  // Final upstream call must have used the new bearer (no refresh-and-retry).
  const upstream = calls.filter((c) =>
    c.url.startsWith("https://api.anthropic.com/v1/messages"),
  );
  assert.equal(upstream.at(-1)?.auth, "Bearer new-access");
});

test("POST /admin/reload requires the API key", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  const manager = makeManager(authDir, [makeToken()]);
  const server = await startApp(makeConfig(authDir), manager);
  t.after(async () => {
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });
  const noAuth = await requestJson({
    server,
    method: "POST",
    path: "/admin/reload",
  });
  assert.equal(noAuth.status, 401);
  const wrongAuth = await requestJson({
    server,
    method: "POST",
    path: "/admin/reload",
    headers: { Authorization: "Bearer wrong" },
  });
  assert.equal(wrongAuth.status, 403);
});

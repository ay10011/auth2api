import crypto from "crypto";
import readline from "readline";
import { Config, loadConfig, resolveAuthDir } from "./config";
import { ProviderId } from "./auth/types";
import { generatePKCECodes } from "./auth/pkce";
import { waitForCallback } from "./auth/callback-server";
import { buildRegistry, ProviderRegistry } from "./providers/registry";
import { createServer } from "./server";
import { notifyServerReload } from "./utils/notify-reload";

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function parseProviderArg(args: string[]): ProviderId {
  const flag = args.find((a) => a.startsWith("--provider="));
  if (!flag) return "anthropic";
  const value = flag.split("=", 2)[1];
  if (value === "anthropic" || value === "codex") return value;
  throw new Error(`Unknown provider "${value}". Supported: anthropic, codex`);
}

async function doLogin(
  config: Config,
  registry: ProviderRegistry,
  providerId: ProviderId,
  manual: boolean,
): Promise<void> {
  const provider = registry.get(providerId);

  const pkce = generatePKCECodes();
  const state = crypto.randomBytes(16).toString("hex");

  const authURL = provider.buildAuthUrl(state, pkce);
  console.log(`\nLogging in to ${provider.id}.`);
  console.log("Open this URL in your browser to login:\n");
  console.log(authURL);

  let code: string;
  let returnedState: string;

  if (manual) {
    console.log(
      "\nAfter login, your browser will redirect to a localhost URL that may fail to load.",
    );
    console.log(
      "Copy the FULL URL from your browser address bar and paste it here.\n",
    );
    const callbackURL = await prompt("Paste callback URL: ");

    const url = new URL(callbackURL);
    code = url.searchParams.get("code") || "";
    returnedState = url.searchParams.get("state") || "";

    if (!code) {
      console.error("Error: No authorization code found in URL");
      process.exit(1);
    }
    if (returnedState !== state) {
      console.error("Error: State mismatch — possible CSRF attack");
      process.exit(1);
    }
  } else {
    console.log("\nWaiting for OAuth callback...\n");
    const result = await waitForCallback({
      port: provider.oauth.callbackPort,
      callbackPath: provider.oauth.callbackPath,
    });
    code = result.code;
    returnedState = result.state;
  }

  console.log("Exchanging code for tokens...");
  const tokenData = await provider.exchangeCode(
    code,
    returnedState,
    state,
    pkce,
  );
  if (!tokenData.provider) tokenData.provider = provider.id;
  provider.manager.addAccount(tokenData);
  console.log(`\nLogin successful! Account: ${tokenData.email}`);
  console.log(`Token expires: ${tokenData.expiresAt}`);
  await notifyServerReload(config);
}

async function startServer(): Promise<void> {
  const configPath = process.argv
    .find((a) => a.startsWith("--config="))
    ?.split("=")[1];
  const config = loadConfig(configPath);
  const authDir = resolveAuthDir(config["auth-dir"]);

  const registry = buildRegistry(authDir);
  for (const p of registry.all()) p.manager.load();

  const totalAccounts = registry
    .all()
    .reduce((sum, p) => sum + p.manager.accountCount, 0);
  if (totalAccounts === 0) {
    console.log(
      "No accounts found. Run with --login (and optionally --provider=codex) to add an account first.",
    );
    process.exit(1);
  }

  for (const p of registry.all()) {
    if (p.manager.accountCount > 0) {
      p.manager.startAutoRefresh();
      p.manager.startStatsLogger();
    }
  }

  const app = createServer(config, registry);
  const host = config.host || "127.0.0.1";
  const port = config.port;

  app.listen(port, host, () => {
    console.log(`auth2api running on http://${host}:${port}`);
    console.log(`Endpoints:`);
    console.log(`  POST /v1/chat/completions`);
    console.log(`  POST /v1/responses`);
    console.log(`  POST /v1/messages`);
    console.log(`  POST /v1/messages/count_tokens`);
    console.log(`  GET  /v1/models`);
    console.log(`  GET  /admin/accounts`);
    console.log(`  GET  /health`);
  });

  process.on("SIGINT", () => {
    for (const p of registry.all()) {
      p.manager.stopAutoRefresh();
      p.manager.stopStatsLogger();
    }
    process.exit(0);
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const configPath = args.find((a) => a.startsWith("--config="))?.split("=")[1];
  const config = loadConfig(configPath);
  const authDir = resolveAuthDir(config["auth-dir"]);

  if (args.includes("--login")) {
    const manual = args.includes("--manual");
    const providerId = parseProviderArg(args);
    const registry = buildRegistry(authDir);
    for (const p of registry.all()) p.manager.load();
    await doLogin(config, registry, providerId, manual);
  } else {
    await startServer();
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});

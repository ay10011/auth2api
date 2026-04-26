import { Request, Response as ExpressResponse } from "express";
import { Config, isDebugLevel } from "../config";
import { extractUsage } from "../accounts/manager";
import { ProviderRegistry } from "../providers/registry";
import { proxyWithRetry } from "../utils/http";
import { resolveModel } from "../upstream/translator";
import { handleStreamingResponse } from "../upstream/streaming";

// POST /v1/messages — Anthropic native format passthrough
export function createMessagesHandler(
  config: Config,
  registry: ProviderRegistry,
) {
  return async (req: Request, resp: ExpressResponse): Promise<void> => {
    try {
      const body = req.body;
      if (
        !body.messages ||
        !Array.isArray(body.messages) ||
        body.messages.length === 0
      ) {
        resp.status(400).json({
          error: {
            message: "messages is required and must be a non-empty array",
          },
        });
        return;
      }

      if (isDebugLevel(config.debug, "verbose")) {
        console.log("[DEBUG] Incoming /v1/messages body:");
        console.log(JSON.stringify(body, null, 2));
      }

      const model = resolveModel(body.model || "claude-sonnet-4-6");
      const provider = registry.forModel(model);

      // Codex path: /v1/messages × codex needs an Anthropic-Messages →
      // OpenAI-Responses translator pair, deferred to a follow-up PR.
      if (provider.nativeFormat === "openai-responses") {
        resp.status(400).json({
          error: {
            message:
              "This model is served by the codex provider, which does not support /v1/messages. Use /v1/responses instead.",
            type: "unsupported_endpoint_for_provider",
            provider: provider.id,
          },
        });
        return;
      }

      const stream = !!body.stream;

      await proxyWithRetry("Messages", resp, config, {
        manager: provider.manager,
        upstream: (account) => {
          const cloaked =
            provider.applyCloaking?.({
              request: req,
              account,
              config,
            }) ?? body;
          return provider.callMessages({
            body: cloaked,
            request: req,
            account,
            config,
          });
        },
        success: async (upstream, account) => {
          if (stream) {
            const result = await handleStreamingResponse(upstream, resp);
            if (result.completed) {
              provider.manager.recordSuccess(account.token.email, result.usage);
            } else if (!result.clientDisconnected) {
              provider.manager.recordFailure(
                account.token.email,
                "network",
                "stream terminated before completion",
              );
            }
          } else {
            const anthropicResp = await upstream.json();
            provider.manager.recordSuccess(
              account.token.email,
              extractUsage(anthropicResp),
            );
            resp.json(anthropicResp);
          }
        },
      });
    } catch (err: any) {
      console.error("Messages handler error:", err.message);
      resp.status(500).json({ error: { message: "Internal server error" } });
    }
  };
}

// POST /v1/messages/count_tokens — passthrough
export function createCountTokensHandler(
  config: Config,
  registry: ProviderRegistry,
) {
  return async (req: Request, resp: ExpressResponse): Promise<void> => {
    try {
      const body = req.body;
      const model = resolveModel(body?.model || "claude-sonnet-4-6");
      const provider = registry.forModel(model);

      if (!provider.callCountTokens) {
        resp.status(501).json({
          error: {
            message: `count_tokens is not supported for the ${provider.id} provider.`,
            type: "unsupported_endpoint_for_provider",
            provider: provider.id,
          },
        });
        return;
      }

      const callCountTokens = provider.callCountTokens.bind(provider);
      await proxyWithRetry("CountTokens", resp, config, {
        manager: provider.manager,
        upstream: (account) =>
          callCountTokens({ request: req, account, config }),
        success: async (upstream, account) => {
          provider.manager.recordSuccess(account.token.email);
          const data = await upstream.json();
          resp.json(data);
        },
      });
    } catch (err: any) {
      console.error("Count tokens error:", err.message);
      resp.status(500).json({ error: { message: "Internal server error" } });
    }
  };
}

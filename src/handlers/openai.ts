import { Request, Response as ExpressResponse } from "express";
import { Config, isDebugLevel } from "../config";
import { extractUsage } from "../accounts/manager";
import { ProviderRegistry } from "../providers/registry";
import { proxyWithRetry } from "../utils/http";
import {
  resolveModel,
  openaiToAnthropic,
  anthropicToOpenai,
  createStreamState,
  anthropicSSEToChat,
  responsesToAnthropic,
  anthropicToResponses,
  makeResponsesState,
  anthropicSSEToResponses,
} from "../upstream/translator";
import { handleStreamingResponse } from "../upstream/streaming";
import { normalizeCodexResponsesBody } from "../upstream/codex-api";

function openaiErrorBody(status: number, body: string): any {
  try {
    const parsed = JSON.parse(body);
    // Codex backend uses { detail: "..." }; Anthropic uses { error: {...} };
    // OpenAI itself uses { error: { message, type, code } }.
    const msg =
      parsed?.error?.message ||
      (typeof parsed?.detail === "string" ? parsed.detail : null) ||
      parsed?.error?.error?.message ||
      "Upstream request failed";
    const type = parsed?.error?.type || "upstream_error";
    return { error: { message: msg, type } };
  } catch {
    return {
      error: { message: "Upstream request failed", type: "upstream_error" },
    };
  }
}

// POST /v1/chat/completions — OpenAI Chat Completions format
export function createChatCompletionsHandler(
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

      const stream = !!body.stream;
      const model = resolveModel(body.model || "claude-sonnet-4-6");
      const provider = registry.forModel(model);

      // Codex path on /v1/chat/completions is deferred — translation
      // (chat ↔ responses) ships in a follow-up PR.
      if (provider.nativeFormat === "openai-responses") {
        resp.status(400).json({
          error: {
            message:
              "This model is served by the codex provider, which currently only supports /v1/responses. Use that endpoint instead.",
            type: "unsupported_endpoint_for_provider",
            provider: provider.id,
          },
        });
        return;
      }

      const structured =
        body.response_format?.type === "json_object" ||
        body.response_format?.type === "json_schema";
      const translatedBody = openaiToAnthropic(body);

      if (isDebugLevel(config.debug, "verbose")) {
        console.log(
          "[DEBUG] Translated OpenAI->Anthropic body (before cloaking):",
        );
        console.log(JSON.stringify(translatedBody, null, 2));
      }

      await proxyWithRetry("ChatCompletions", resp, config, {
        manager: provider.manager,
        upstream: (account) => {
          const cloaked =
            provider.applyCloaking?.({
              body: translatedBody,
              request: req,
              account,
              config,
            }) ?? translatedBody;
          return provider.callMessages({
            body: cloaked,
            request: req,
            account,
            config,
            structured,
          });
        },
        success: async (upstream, account) => {
          if (stream) {
            const includeUsage = body.stream_options?.include_usage !== false;
            const state = createStreamState(model, includeUsage);
            const result = await handleStreamingResponse(upstream, resp, {
              onEvent: (event, data, usage) =>
                anthropicSSEToChat(event, data, state, usage).map(
                  (c) => `data: ${c}\n\n`,
                ),
            });
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
            resp.json(anthropicToOpenai(anthropicResp, model));
          }
        },
        errorAdapter: openaiErrorBody,
      });
    } catch (err: any) {
      console.error("Handler error:", err.message);
      resp.status(500).json({ error: { message: "Internal server error" } });
    }
  };
}

// POST /v1/responses — OpenAI Responses API format
export function createResponsesHandler(
  config: Config,
  registry: ProviderRegistry,
) {
  return async (req: Request, resp: ExpressResponse): Promise<void> => {
    try {
      const body = req.body;
      if (!body.input && !body.messages) {
        resp.status(400).json({ error: { message: "input is required" } });
        return;
      }

      const model = resolveModel(body.model || "claude-sonnet-4-6");
      const provider = registry.forModel(model);

      // Codex path: passthrough — body and response are already in Responses
      // shape, no translation needed. Fill in protocol-required fields that
      // off-the-shelf clients commonly omit (stream/store/instructions); we do
      // NOT override values the client set explicitly.
      const normalizedBody =
        provider.nativeFormat === "openai-responses"
          ? normalizeCodexResponsesBody(body)
          : body;
      const stream = !!normalizedBody.stream;

      if (provider.nativeFormat === "openai-responses") {
        await proxyWithRetry("Responses", resp, config, {
          manager: provider.manager,
          upstream: (account) =>
            provider.callMessages({
              body: normalizedBody,
              request: req,
              account,
              config,
            }),
          success: async (upstream, account) => {
            if (stream) {
              const result = await handleStreamingResponse(upstream, resp);
              if (result.completed) {
                provider.manager.recordSuccess(
                  account.token.email,
                  result.usage,
                );
              } else if (!result.clientDisconnected) {
                provider.manager.recordFailure(
                  account.token.email,
                  "network",
                  "stream terminated before completion",
                );
              }
            } else {
              const upstreamJson = await upstream.json();
              provider.manager.recordSuccess(
                account.token.email,
                extractUsage(upstreamJson),
              );
              resp.json(upstreamJson);
            }
          },
        });
        return;
      }

      // Anthropic path: translate Responses → Anthropic Messages, then back.
      const structured =
        body.text?.format?.type === "json_object" ||
        body.text?.format?.type === "json_schema";
      const translatedBody = responsesToAnthropic(body);

      await proxyWithRetry("Responses", resp, config, {
        manager: provider.manager,
        upstream: (account) => {
          const cloaked =
            provider.applyCloaking?.({
              body: translatedBody,
              request: req,
              account,
              config,
            }) ?? translatedBody;
          return provider.callMessages({
            body: cloaked,
            request: req,
            account,
            config,
            structured,
          });
        },
        success: async (upstream, account) => {
          if (stream) {
            const state = makeResponsesState();
            const streamResp = await handleStreamingResponse(upstream, resp, {
              onEvent: (event, data, usage) =>
                anthropicSSEToResponses(event, data, state, model, usage),
            });
            if (streamResp.completed) {
              provider.manager.recordSuccess(
                account.token.email,
                streamResp.usage,
              );
            } else if (!streamResp.clientDisconnected) {
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
            resp.json(anthropicToResponses(anthropicResp, model));
          }
        },
        errorAdapter: openaiErrorBody,
      });
    } catch (err: any) {
      console.error("Responses handler error:", err.message);
      resp.status(500).json({ error: { message: "Internal server error" } });
    }
  };
}

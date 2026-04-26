import { Response as ExpressResponse } from "express";
import { UsageData } from "../accounts/manager";

export type SSEEventHandler = (
  event: string,
  data: any,
  usage: UsageData,
) => string[];

export interface StreamOptions {
  onEvent?: SSEEventHandler;
}

export interface StreamResult {
  completed: boolean;
  clientDisconnected: boolean;
  usage: UsageData;
}

function extractUsageFromSSE(event: string, data: any, usage: UsageData): void {
  // Anthropic Messages stream — usage arrives on message_delta.
  if (event === "message_delta") {
    const u = data?.usage;
    if (!u) return;
    usage.inputTokens = u.input_tokens || 0;
    usage.outputTokens = u.output_tokens || 0;
    usage.cacheCreationInputTokens = u.cache_creation_input_tokens || 0;
    usage.cacheReadInputTokens = u.cache_read_input_tokens || 0;
    return;
  }
  // OpenAI Responses stream — usage arrives on response.completed under
  // response.usage (matches codex-rs/codex-api/src/sse/responses.rs).
  if (event === "response.completed") {
    const u = data?.response?.usage;
    if (!u) return;
    usage.inputTokens = u.input_tokens || 0;
    usage.outputTokens = u.output_tokens || 0;
    usage.cacheReadInputTokens = u.input_tokens_details?.cached_tokens || 0;
    usage.reasoningOutputTokens =
      u.output_tokens_details?.reasoning_tokens || 0;
    // Codex has no cache_creation analog; leave at default.
    return;
  }
}

export async function handleStreamingResponse(
  upstream: Response,
  resp: ExpressResponse,
  options?: StreamOptions,
): Promise<StreamResult> {
  const usage: UsageData = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    reasoningOutputTokens: 0,
  };

  resp.setHeader("Content-Type", "text/event-stream");
  resp.setHeader("Cache-Control", "no-cache");
  resp.setHeader("Connection", "keep-alive");
  resp.setHeader("X-Accel-Buffering", "no");
  resp.flushHeaders();

  const reader = upstream.body?.getReader();
  if (!reader) {
    resp.end();
    return { completed: true, clientDisconnected: false, usage };
  }

  const decoder = new TextDecoder();

  let buffer = "";
  let currentEvent = "";
  let clientDisconnected = false;
  let completed = false;

  resp.on("close", () => {
    clientDisconnected = true;
    reader.cancel().catch(() => {});
  });

  try {
    while (!clientDisconnected) {
      const { done, value } = await reader.read();

      if (done) break;

      if (!options?.onEvent) {
        resp.write(value);
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (clientDisconnected) break;

        if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          const raw = line.slice(5).trim();
          if (!raw) continue;
          try {
            const data = JSON.parse(raw);
            extractUsageFromSSE(currentEvent, data, usage);
            if (options?.onEvent) {
              const chunks = options.onEvent(currentEvent, data, usage);
              for (const c of chunks) {
                if (!clientDisconnected) resp.write(c);
              }
            }
          } catch {
            /* ignore parse errors */
          }
        }
      }
    }
    completed = true;
  } catch (err) {
    if (!clientDisconnected) console.error("Stream error:", err);
  } finally {
    if (!clientDisconnected) {
      resp.end();
    }
  }

  return { completed, clientDisconnected, usage };
}

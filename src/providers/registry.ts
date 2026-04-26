import { ProviderId } from "../auth/types";
import { resolveModel } from "../upstream/translator";
import { buildAnthropicProvider } from "./anthropic";
import { buildCodexProvider } from "./codex";
import { Provider } from "./types";

export interface ProviderRegistry {
  get(id: ProviderId): Provider;
  /** Provider that should serve `model`. Falls back to anthropic. */
  forModel(model: string): Provider;
  all(): Provider[];
  /** Providers that have at least one logged-in account. */
  withAccounts(): Provider[];
}

export function buildRegistry(authDir: string): ProviderRegistry {
  const anthropic = buildAnthropicProvider(authDir);
  const codex = buildCodexProvider(authDir);
  const byId: Record<ProviderId, Provider> = { anthropic, codex };
  const ordered: Provider[] = [anthropic, codex];

  return {
    get: (id) => {
      const p = byId[id];
      if (!p) throw new Error(`Unknown provider: ${id}`);
      return p;
    },
    forModel: (model) => {
      const resolved = resolveModel(model);
      // Prefer explicit provider match. Codex regex first because anthropic's
      // regex is also a fallback; explicit match avoids surprises on aliases.
      if (codex.matchesModel(resolved)) return codex;
      if (anthropic.matchesModel(resolved)) return anthropic;
      // Default to anthropic for unknown models — preserves prior behaviour.
      return anthropic;
    },
    all: () => ordered.slice(),
    withAccounts: () => ordered.filter((p) => p.manager.accountCount > 0),
  };
}

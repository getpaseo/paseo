import type { EmbeddingProvider, IndexingState } from "./types.js";

/**
 * Translate a workspace-level embedding provider config into the env vars
 * code-review-graph reads at startup (see its `embeddings.py get_provider`).
 *
 * Hubcode's crg is a single global subprocess — but embedding config is
 * per-workspace. We resolve a *single effective* provider by picking the
 * most-recently-updated enabled workspace that has one configured. Caller
 * restarts the subprocess when this effective provider changes so the new
 * env takes effect.
 */

export interface EnvSnapshot {
  env: Record<string, string>;
  source: {
    workspaceId: string | null;
    providerKind: EmbeddingProvider["kind"] | "unset";
    note?: string;
  };
}

/**
 * Build the env overlay for the crg subprocess from a list of workspace
 * indexing states. The caller merges this into `process.env` before spawn.
 */
export function buildEmbeddingEnv(
  entries: Array<{ workspaceId: string; state: IndexingState; updatedAt?: string | null }>,
): EnvSnapshot {
  const eligible = entries
    .filter((e) => e.state.enabled && e.state.embeddingProvider)
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  const chosen = eligible[0];
  if (!chosen || !chosen.state.embeddingProvider) {
    return {
      env: {},
      source: { workspaceId: null, providerKind: "unset" },
    };
  }
  const provider = chosen.state.embeddingProvider;
  switch (provider.kind) {
    case "none":
      return {
        env: {},
        source: { workspaceId: chosen.workspaceId, providerKind: "none" },
      };
    case "openai-compat":
      return {
        env: openaiCompatEnv(provider),
        source: { workspaceId: chosen.workspaceId, providerKind: "openai-compat" },
      };
    case "sentence-transformers": {
      const env: Record<string, string> = {};
      if (provider.config?.model) env.CRG_EMBEDDING_MODEL = provider.config.model;
      return {
        env,
        source: { workspaceId: chosen.workspaceId, providerKind: "sentence-transformers" },
      };
    }
    case "hubcode-local":
      // The actual env (CRG_OPENAI_BASE_URL pointing at the loopback
      // embedding server) is injected separately by `IndexingService`
      // because the URL/token aren't known at this layer. Here we emit a
      // marker so the diff logic detects the kind change and triggers a
      // restart; the service overlays the loopback details later.
      return {
        env: { CRG_HUBCODE_LOCAL: "1" },
        source: { workspaceId: chosen.workspaceId, providerKind: "hubcode-local" },
      };
    default:
      return {
        env: {},
        source: { workspaceId: chosen.workspaceId, providerKind: "unset" },
      };
  }
}

function openaiCompatEnv(provider: EmbeddingProvider): Record<string, string> {
  const env: Record<string, string> = {};
  if (provider.config?.baseUrl) env.CRG_OPENAI_BASE_URL = provider.config.baseUrl;
  if (provider.config?.model) env.CRG_OPENAI_MODEL = provider.config.model;
  if (provider.config?.apiKey) env.CRG_OPENAI_API_KEY = provider.config.apiKey;
  if (provider.config?.dimension != null) {
    env.CRG_OPENAI_DIMENSION = String(provider.config.dimension);
  }
  // Required to silence crg's cloud egress warning for localhost endpoints.
  // The URL check in crg already skips the warning for loopback hosts, so this
  // acts as an explicit opt-in for remote endpoints the user chose.
  env.CRG_ACCEPT_CLOUD_EMBEDDINGS = "1";
  return env;
}

/**
 * Compare two env snapshots and decide whether restart is needed. Pure —
 * tests use this directly.
 */
export function envSnapshotEquals(a: EnvSnapshot, b: EnvSnapshot): boolean {
  if (a.source.providerKind !== b.source.providerKind) return false;
  if (a.source.workspaceId !== b.source.workspaceId) return false;
  const aKeys = Object.keys(a.env).sort();
  const bKeys = Object.keys(b.env).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i += 1) {
    const k = aKeys[i];
    if (k !== bKeys[i]) return false;
    if (!k || a.env[k] !== b.env[k]) return false;
  }
  return true;
}

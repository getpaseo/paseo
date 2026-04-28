import { z } from "zod";

export const INDEXING_AGENT_IDS = [
  "claude-code",
  "codex",
  "cursor",
  "gemini",
  "opencode",
  "copilot",
  "hubcode-gui",
] as const;

export type IndexingAgentId = (typeof INDEXING_AGENT_IDS)[number];

export const EmbeddingProviderKindSchema = z.enum([
  "none",
  "hubcode-local",
  "openai-compat",
  "sentence-transformers",
]);

export const EmbeddingProviderConfigSchema = z.object({
  baseUrl: z.string().optional(),
  model: z.string().optional(),
  apiKey: z.string().optional(),
  dimension: z.number().int().positive().optional(),
});

export const EmbeddingProviderSchema = z.object({
  kind: EmbeddingProviderKindSchema,
  config: EmbeddingProviderConfigSchema.optional(),
});

export const IndexingPhaseSchema = z.enum(["idle", "installing", "indexing", "ready", "error"]);

export const IndexingStatusSchema = z.object({
  phase: IndexingPhaseSchema,
  nodeCount: z.number().int().nonnegative().optional(),
  fileCount: z.number().int().nonnegative().optional(),
  lastIndexedAt: z.string().optional(),
  indexBytes: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
  progress: z.number().min(0).max(100).optional(),
});

export const ExposeToEntrySchema = z.object({
  enabled: z.boolean(),
  enabledTools: z.array(z.string()).optional(),
});

export const ExposeToSchema = z.record(z.string(), ExposeToEntrySchema);

// All fields required so the input type matches the output type — required
// by the `z.ZodSchema<TRecord>` constraint in `FileBackedRegistry`. Defaults
// are applied programmatically via `defaultIndexingState`/`normalizeIndexingState`
// rather than through `.default()` on the schema.
export const IndexingStateSchema = z.object({
  enabled: z.boolean(),
  embeddingProvider: EmbeddingProviderSchema.optional(),
  watchlist: z.array(z.string()),
  exposeTo: ExposeToSchema,
  status: IndexingStatusSchema,
});

export type EmbeddingProviderKind = z.infer<typeof EmbeddingProviderKindSchema>;
export type EmbeddingProviderConfig = z.infer<typeof EmbeddingProviderConfigSchema>;
export type EmbeddingProvider = z.infer<typeof EmbeddingProviderSchema>;
export type IndexingPhase = z.infer<typeof IndexingPhaseSchema>;
export type IndexingStatus = z.infer<typeof IndexingStatusSchema>;
export type ExposeToEntry = z.infer<typeof ExposeToEntrySchema>;
export type ExposeTo = z.infer<typeof ExposeToSchema>;
export type IndexingState = z.infer<typeof IndexingStateSchema>;

/**
 * Default indexing state for workspaces that haven't been touched yet.
 *   - `enabled: true` — opening a project should make tools available
 *     without a manual toggle.
 *   - `embeddingProvider: hubcode-local` — semantic search is on by
 *     default with the in-process ONNX model. The model itself only
 *     downloads on the first inference call (lazy via transformers.js),
 *     so this is free at boot.
 */
export function defaultIndexingState(): IndexingState {
  return {
    enabled: true,
    embeddingProvider: { kind: "hubcode-local" },
    watchlist: [],
    exposeTo: {},
    status: { phase: "idle" },
  };
}

/**
 * Loosely-typed normalizer for partially-populated state coming from the UI
 * or older persisted shapes. Fills in the defaults that the strict schema
 * no longer auto-applies, then validates.
 */
export function normalizeIndexingState(input: unknown): IndexingState {
  const base = defaultIndexingState();
  if (!input || typeof input !== "object") return base;
  const merged = { ...base, ...(input as Partial<IndexingState>) };
  if (!merged.watchlist) merged.watchlist = [];
  if (!merged.exposeTo) merged.exposeTo = {};
  if (!merged.status) merged.status = { phase: "idle" };
  return IndexingStateSchema.parse(merged);
}

/**
 * Resolve effective tool exposure for an agent. An absent entry, or an entry
 * without `enabledTools`, means "all tools enabled".
 */
export function isToolEnabledForAgent(
  state: IndexingState,
  agentId: string,
  toolName: string,
): boolean {
  if (!state.enabled) return false;
  const entry = state.exposeTo[agentId];
  if (!entry) return true;
  if (!entry.enabled) return false;
  if (!entry.enabledTools) return true;
  return entry.enabledTools.includes(toolName);
}

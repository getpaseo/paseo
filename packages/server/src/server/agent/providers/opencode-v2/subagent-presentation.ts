export interface OpenCodeV2SubagentPresentationFacts {
  /** OpenCode 2 agent name running the child, e.g. "general", "explore". */
  agentName?: string;
  /** Raw model id, e.g. "deepseek-ai/DeepSeek-V4-Flash-0731". OpenCode 2 has no label table at translation time. */
  modelId?: string;
  /** Thinking level, e.g. "high", "max". */
  variant?: string;
  /** Latest assistant message token sum (input+output+reasoning+cache). */
  totalTokens?: number;
}

/**
 * Per-child presentation tracking: raw facts plus the last subtitle emitted, so
 * repeated folds of the same facts never re-emit an identical upsert.
 */
export interface OpenCodeV2SubagentPresentationState {
  facts: OpenCodeV2SubagentPresentationFacts;
  lastSubtitle?: string;
  /** A descriptor title has been emitted from detection, linking, or assistant facts. */
  titleEmitted?: boolean;
  /** Set once the parent `subagent` tool call has been linked to this child. */
  linkedToolCallId?: string;
  /** The link upsert carried a title (subAgentType); detection must not overwrite it. */
  titleFromLink?: boolean;
  /** The link upsert carried a description (task input); detection must not overwrite it. */
  descriptionFromLink?: boolean;
}

/** Claim the assistant/session agent as the descriptor title when no stronger title exists. */
export function claimOpenCodeV2SubagentFallbackTitle(
  state: OpenCodeV2SubagentPresentationState,
  agentName: string | undefined,
): string | undefined {
  const title = readPart(agentName);
  if (!title || state.titleFromLink || state.titleEmitted) return undefined;
  // Title means subagent type, so claim it once rather than refreshing on a mid-session handoff.
  state.titleEmitted = true;
  return title;
}

/** Build the complete compact subtitle OpenCode 2 exposes to provider-neutral clients. */
export function buildOpenCodeV2SubagentSubtitle(
  facts: OpenCodeV2SubagentPresentationFacts,
): string | undefined {
  const parts = [
    readPart(facts.agentName),
    readPart(facts.modelId),
    formatVariant(facts.variant),
    formatTokens(facts.totalTokens),
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * Merge observed facts into the tracked state and return the folded subtitle only
 * when it differs from the last one emitted; otherwise return undefined.
 */
export function foldOpenCodeV2SubagentPresentation(
  state: OpenCodeV2SubagentPresentationState,
  patch: OpenCodeV2SubagentPresentationFacts,
): string | undefined {
  if (patch.agentName !== undefined) state.facts.agentName = patch.agentName;
  if (patch.modelId !== undefined) state.facts.modelId = patch.modelId;
  if (patch.variant !== undefined) state.facts.variant = patch.variant;
  if (patch.totalTokens !== undefined) state.facts.totalTokens = patch.totalTokens;
  const subtitle = buildOpenCodeV2SubagentSubtitle(state.facts);
  if (!subtitle || subtitle === state.lastSubtitle) return undefined;
  state.lastSubtitle = subtitle;
  return subtitle;
}

function readPart(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function formatVariant(variant: string | undefined): string | undefined {
  const normalized = readPart(variant);
  if (!normalized) return undefined;
  if (normalized === "xhigh") return "Extra High";
  return normalized
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatTokens(totalTokens: number | undefined): string | undefined {
  if (typeof totalTokens !== "number" || totalTokens <= 0) return undefined;
  if (totalTokens < 1000) return `${Math.round(totalTokens)} tokens`;
  return `${Math.round(totalTokens / 100) / 10}k tokens`;
}

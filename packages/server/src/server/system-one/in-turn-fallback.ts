import type { AgentProfile } from "@getpaseo/protocol/agent-profile";
import type { AgentTimelineItem, AgentPromptInput } from "../agent/agent-sdk-types.js";

export interface FallbackModel {
  id: string;
  label?: string;
  capabilities?: readonly string[];
}

export interface InTurnFallbackCandidate {
  profile: AgentProfile;
  model: string | undefined;
  reason: "next-profile" | "capability-fallback";
}

export interface InTurnFallbackInput {
  currentProfileId?: string;
  currentProvider: string;
  currentModel?: string;
  profiles: readonly AgentProfile[];
  availableModels?: readonly FallbackModel[];
  attemptedProfileIds?: readonly string[];
}

export interface InTurnRetryPlan {
  candidate: InTurnFallbackCandidate;
  prompt: AgentPromptInput;
  /** The canonical Paseo timeline is replayed into the replacement session. */
  context: {
    kind: "timeline";
    history: readonly AgentTimelineItem[];
  };
}

/** Providers with independent configured accounts are tried before less common profiles. */
export const DEFAULT_FALLBACK_PROVIDER_ORDER = ["claude", "codex"] as const;

const QUOTA_ERROR_PATTERN =
  /(?:rate\s*limit|rate_limit|too many requests|quota|usage limit|limit exceeded|resource exhausted|429)/i;

export function isQuotaOrRateLimitError(error: unknown): boolean {
  if (typeof error === "string") return QUOTA_ERROR_PATTERN.test(error);
  if (!error || typeof error !== "object") return false;

  const value = error as Record<string, unknown>;
  return [value.code, value.status, value.error, value.message, value.diagnostic].some(
    (part) => typeof part === "string" && QUOTA_ERROR_PATTERN.test(part),
  );
}

/**
 * Pick the next configured profile only. This never invents an account or a provider.
 * The current provider gets its next configured profile first, then the stable provider order.
 */
export function selectNextInTurnFallback(
  input: InTurnFallbackInput,
): InTurnFallbackCandidate | null {
  const attempted = new Set(input.attemptedProfileIds ?? []);
  if (input.currentProfileId) attempted.add(input.currentProfileId);

  const candidates = input.profiles
    .filter((profile) => !attempted.has(profile.id))
    .map((profile, index) => ({
      profile,
      index,
      sameProvider: profile.provider === input.currentProvider,
      providerRank: providerRank(profile.provider),
    }))
    .sort(
      (a, b) =>
        Number(b.sameProvider) - Number(a.sameProvider) ||
        a.providerRank - b.providerRank ||
        a.index - b.index,
    );

  const selected = candidates[0]?.profile;
  if (!selected) return null;

  const model = resolveFallbackModel({
    currentModel: input.currentModel,
    requestedModel: selected.model,
    availableModels: input.availableModels,
  });
  return {
    profile: selected,
    model,
    reason: model !== selected.model ? "capability-fallback" : "next-profile",
  };
}

export function createInTurnRetryPlan(input: {
  prompt: AgentPromptInput;
  history: readonly AgentTimelineItem[];
  candidate: InTurnFallbackCandidate;
}): InTurnRetryPlan {
  return {
    candidate: input.candidate,
    prompt: input.prompt,
    context: { kind: "timeline", history: input.history },
  };
}

export function inTurnFallbackVisibility(
  current: { provider: string; model?: string },
  candidate: InTurnFallbackCandidate,
): AgentTimelineItem[] {
  const from = [current.provider, current.model].filter(Boolean).join(" · ");
  const to = [candidate.profile.provider, candidate.model ?? candidate.profile.model]
    .filter(Boolean)
    .join(" · ");
  return [
    {
      type: "notification",
      level: "warning",
      message: `Quota limit reached. Continuing this turn with ${to} (from ${from}).`,
    },
  ];
}

export function inTurnFallbackExhaustedVisibility(): AgentTimelineItem {
  return {
    type: "notification",
    level: "error",
    message:
      "Quota limit reached. No configured provider profile is available to continue this turn.",
  };
}

export function resolveFallbackModel(input: {
  currentModel?: string;
  requestedModel?: string;
  availableModels?: readonly FallbackModel[];
}): string | undefined {
  const available = input.availableModels ?? [];
  if (input.requestedModel && isAvailable(input.requestedModel, available)) {
    return input.requestedModel;
  }
  if (available.length === 0) return input.requestedModel;

  const currentFamily = modelFamily(input.currentModel);
  const preferredFamilies =
    currentFamily === "opus" || currentFamily === "sonnet" ? ["sol", "luna"] : ["sol", "luna"];
  for (const family of preferredFamilies) {
    const match = available.find((model) => modelFamily(model.id) === family);
    if (match) return match.id;
  }
  return available[0]?.id;
}

function isAvailable(modelId: string, models: readonly FallbackModel[]): boolean {
  return models.some((model) => model.id === modelId);
}

function modelFamily(model: string | undefined): string {
  const normalized = model?.toLowerCase() ?? "";
  if (normalized.includes("opus")) return "opus";
  if (normalized.includes("sonnet")) return "sonnet";
  if (normalized.includes("sol")) return "sol";
  if (normalized.includes("luna")) return "luna";
  return "unknown";
}

function providerRank(provider: string): number {
  const index = DEFAULT_FALLBACK_PROVIDER_ORDER.indexOf(
    provider as (typeof DEFAULT_FALLBACK_PROVIDER_ORDER)[number],
  );
  return index === -1 ? DEFAULT_FALLBACK_PROVIDER_ORDER.length : index;
}

import { z } from "zod";
import { toneFromUsedPct } from "../../../../services/quota-fetcher/usage.js";
import type { AgentPlanUsageWindow } from "../../agent-sdk-types.js";

// Claude Code emits `rate_limit_event` on every API call with the plan windows the
// response headers carried. The SDK types describe one representative claim
// (`rateLimitType` + `utilization`); the runtime additionally sends
// `unifiedWindows`, a map of every window keyed by claim. Both are read here so a
// CLI that only sends the claim still yields one window.
const RateLimitWindowSchema = z
  .object({
    utilization: z.number().nullish(),
    resetsAt: z.number().nullish(),
  })
  .loose();

const RateLimitInfoSchema = z
  .object({
    rateLimitType: z.string().nullish(),
    utilization: z.number().nullish(),
    resetsAt: z.number().nullish(),
    // Entries are validated one at a time below so a single malformed window
    // cannot take the others down with it.
    unifiedWindows: z.record(z.string(), z.unknown()).nullish(),
  })
  .loose();

// Claim keys in display order. Anything the CLI adds later lands after these.
const KNOWN_CLAIMS = [
  "five_hour",
  "seven_day",
  "seven_day_opus",
  "seven_day_sonnet",
  "seven_day_overage_included",
] as const;

// Overage is a purchase state, not a usage window.
const SKIPPED_CLAIMS: ReadonlySet<string> = new Set(["overage"]);

/** "Fable" for `claude-fable-5`, "Opus" for `claude-opus-4-6`, null when unrecognized. */
export function claudeModelFamily(modelId: string | null | undefined): string | null {
  const match = modelId?.match(/fable|opus|sonnet|haiku/i);
  if (!match) return null;
  const family = match[0].toLowerCase();
  return family.charAt(0).toUpperCase() + family.slice(1);
}

function claimLabel(claim: string, modelId: string | null | undefined): string {
  switch (claim) {
    case "five_hour":
      return "Session";
    case "seven_day":
      return "Weekly";
    case "seven_day_opus":
      return "Weekly · Opus";
    case "seven_day_sonnet":
      return "Weekly · Sonnet";
    case "seven_day_overage_included":
      // The per-model weekly bucket of the model being called: it only appears on
      // calls to a model that has one (verified against the usage endpoint's
      // "Weekly · Fable" window on a token holding both scopes).
      return `Weekly · ${claudeModelFamily(modelId) ?? "model"}`;
    default: {
      const words = claim.replace(/_/g, " ").trim();
      return words.charAt(0).toUpperCase() + words.slice(1);
    }
  }
}

function toWindow(
  claim: string,
  utilization: number | null | undefined,
  resetsAt: number | null | undefined,
  modelId: string | null | undefined,
): AgentPlanUsageWindow | null {
  if (typeof utilization !== "number" || !Number.isFinite(utilization)) return null;
  // Utilization is a 0..1 fraction on the wire.
  const usedPct = Math.max(0, Math.round(utilization * 100));
  const window: AgentPlanUsageWindow = {
    id: claim,
    label: claimLabel(claim, modelId),
    usedPct,
    tone: toneFromUsedPct(usedPct),
  };
  if (typeof resetsAt === "number" && Number.isFinite(resetsAt)) {
    window.resetsAt = new Date(resetsAt * 1000).toISOString();
  }
  return window;
}

/**
 * Plan windows from a Claude Code `rate_limit_info` payload, or null when it
 * describes none. `modelId` names the model the agent is running, used to label
 * the per-model weekly window.
 */
export function planWindowsFromRateLimitInfo(
  info: unknown,
  modelId: string | null | undefined,
): AgentPlanUsageWindow[] | null {
  const parsed = RateLimitInfoSchema.safeParse(info);
  if (!parsed.success) return null;
  const data = parsed.data;

  const unified = data.unifiedWindows;
  if (unified) {
    const claims = [
      ...KNOWN_CLAIMS.filter((claim) => claim in unified),
      ...Object.keys(unified).filter(
        (claim) => !(KNOWN_CLAIMS as readonly string[]).includes(claim),
      ),
    ];
    const windows: AgentPlanUsageWindow[] = [];
    for (const claim of claims) {
      if (SKIPPED_CLAIMS.has(claim)) continue;
      const entry = RateLimitWindowSchema.safeParse(unified[claim]);
      if (!entry.success) continue;
      const window = toWindow(claim, entry.data.utilization, entry.data.resetsAt, modelId);
      if (window) windows.push(window);
    }
    return windows.length > 0 ? windows : null;
  }

  if (data.rateLimitType && !SKIPPED_CLAIMS.has(data.rateLimitType)) {
    const window = toWindow(data.rateLimitType, data.utilization, data.resetsAt, modelId);
    return window ? [window] : null;
  }
  return null;
}

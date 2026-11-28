import {
  balanceToneFromRemaining,
  toneFromUsedPct,
  windowFromReportedDuration,
  type UsageBalance,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";
import { z } from "zod";

/** The usage source id the built-in `plugins/codex-usage-source` registers. */
export const CODEX_USAGE_SOURCE_ID = "codex";

export interface ObservedCodexUsage {
  windows: UsageWindow[];
  balances: UsageBalance[];
  planLabel?: string;
}

const RateLimitWindowSchema = z.object({
  usedPercent: z.number().finite(),
  windowDurationMins: z.number().finite().nullish(),
  resetsAt: z.number().finite().nullish(),
});

const IndividualLimitSchema = z.object({
  usedPercent: z.number().finite().nullish(),
  remainingPercent: z.number().finite().nullish(),
  resetsAt: z.number().finite().nullish(),
});

const CreditsSchema = z.object({
  balance: z.union([z.number().finite(), z.string()]).nullish(),
});

const RateLimitSnapshotSchema = z.object({
  limitId: z.string().nullish(),
  limitName: z.string().nullish(),
  planType: z.string().nullish(),
  primary: z.unknown().optional(),
  secondary: z.unknown().optional(),
  individualLimit: z.unknown().optional(),
  credits: z.unknown().optional(),
});

type RateLimitSnapshot = z.infer<typeof RateLimitSnapshotSchema>;

function epochSecondsToIso(seconds: number | null | undefined): string | null {
  return seconds != null ? new Date(seconds * 1000).toISOString() : null;
}

function readSlotWindows(
  data: RateLimitSnapshot,
  scope: { id: string; label: string } | undefined,
  summary: boolean,
): UsageWindow[] {
  const slots = [
    ["primary", data.primary],
    ["secondary", data.secondary],
  ] as const;
  const windows: UsageWindow[] = [];
  for (const [slot, raw] of slots) {
    const parsed = RateLimitWindowSchema.safeParse(raw);
    if (!parsed.success) continue;
    const isPrimary = slot === "primary";
    const durationSeconds =
      parsed.data.windowDurationMins != null ? parsed.data.windowDurationMins * 60 : null;
    windows.push(
      windowFromReportedDuration({
        durationSeconds,
        unknown: {
          id: isPrimary ? "unknown_primary" : "unknown_secondary",
          label: isPrimary ? "Primary limit" : "Secondary limit",
          shortLabel: "",
        },
        scope,
        summary,
        utilizationPct: parsed.data.usedPercent,
        resetsAt: epochSecondsToIso(parsed.data.resetsAt),
        tone: toneFromUsedPct(parsed.data.usedPercent),
      }),
    );
  }
  return windows;
}

function readIndividualLimitWindow(raw: unknown): UsageWindow | null {
  const parsed = IndividualLimitSchema.safeParse(raw);
  if (!parsed.success) return null;
  const usedPct =
    parsed.data.usedPercent ??
    (parsed.data.remainingPercent != null
      ? Math.max(0, Math.min(100, 100 - parsed.data.remainingPercent))
      : undefined);
  if (usedPct === undefined) return null;
  const remainingPct = parsed.data.remainingPercent ?? Math.max(0, 100 - usedPct);
  return {
    id: "individual_limit",
    label: "Individual spend limit",
    summary: true,
    usedPct,
    remainingPct,
    resetsAt: epochSecondsToIso(parsed.data.resetsAt),
    tone: toneFromUsedPct(usedPct),
  };
}

function readCreditsBalance(raw: unknown): UsageBalance | null {
  const parsed = CreditsSchema.safeParse(raw);
  if (!parsed.success || parsed.data.balance == null) return null;
  let balance: number;
  if (typeof parsed.data.balance === "number") {
    balance = parsed.data.balance;
  } else {
    const trimmed = parsed.data.balance.trim();
    if (trimmed.length === 0) return null;
    balance = Number(trimmed);
  }
  if (!Number.isFinite(balance)) return null;
  return {
    id: "credits",
    label: "Credits",
    remaining: balance,
    unit: "credits",
    tone: balanceToneFromRemaining(balance),
  };
}

/**
 * Parses a Codex `account/rateLimits/updated` snapshot into the canonical window, balance, and plan
 * shape produced by `plugins/codex-usage-source`. Returns null when the payload is not an object.
 */
export function readCodexRateLimitUsage(snapshot: unknown): ObservedCodexUsage | null {
  const parsed = RateLimitSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) return null;

  const limitId = parsed.data.limitId?.trim() || null;
  const limitName = parsed.data.limitName?.trim() || null;
  const isDefaultBucket = !limitId || limitId === "codex";
  const scope = isDefaultBucket
    ? undefined
    : { id: `limit:${encodeURIComponent(limitId)}`, label: limitName || limitId };

  const windows = readSlotWindows(parsed.data, scope, isDefaultBucket);
  const individual = readIndividualLimitWindow(parsed.data.individualLimit);
  if (individual) windows.push(individual);

  const credit = readCreditsBalance(parsed.data.credits);
  const balances = credit ? [credit] : [];
  const planLabel = parsed.data.planType?.trim() || undefined;
  return { windows, balances, ...(planLabel ? { planLabel } : {}) };
}

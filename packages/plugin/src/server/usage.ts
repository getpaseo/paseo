import { createHash } from "node:crypto";
import { z, type ZodType } from "zod";
import type { JsonValue } from "@getpaseo/protocol/agent-types";

export interface UsageWindow {
  id: string;
  label: string;
  /**
   * A few characters naming the window where space is tight, e.g. "5h" or "wk". An empty string
   * shows the percent alone; leaving it out shows `label`.
   */
  shortLabel?: string;
  /** Shown in the usage summary until the user pins windows of their own. */
  summary?: boolean;
  usedPct?: number | null;
  remainingPct?: number | null;
  resetsAt?: string | null;
  runsOutAt?: string | null;
  shortfallPct?: number | null;
  tone?: "default" | "ok" | "warning" | "danger";
}

export interface UsageBalance {
  id: string;
  label: string;
  used?: number | null;
  remaining?: number | null;
  limit?: number | null;
  unit: "usd" | "credits" | "requests" | "tokens";
  resetsAt?: string | null;
  tone?: UsageWindow["tone"];
}

export interface UsageDetail {
  id: string;
  label: string;
  value: string;
  tone?: UsageWindow["tone"];
}

export type UsageProblem =
  | { kind: "expired"; expiresAt: string; refreshedBy?: string }
  | { kind: "rejected"; status: number; refreshedBy?: string }
  | { kind: "no_quota"; detail: string };

export type UsageReport =
  | {
      status: "available";
      planLabel?: string;
      windows: UsageWindow[];
      balances?: UsageBalance[];
      details?: UsageDetail[];
    }
  | { status: "unavailable"; problem: UsageProblem }
  | { status: "error"; error: string };

export interface UsageAccount {
  /** Stable across token rotation; [A-Za-z0-9._-]{1,128}. Never a credential or raw email. */
  key: string;
  label?: string;
  /** Harness owning this login, e.g. Codex, OpenCode, Pi or OMP. */
  harness?: string;
  /** Store locator, opaque to the daemon. */
  input: JsonValue;
}

export const UsageScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }),
  z.object({
    kind: z.literal("session"),
    provider: z.string(),
    model: z.string().optional(),
    env: z.record(z.string(), z.string()),
  }),
]);
export type UsageScope = z.infer<typeof UsageScopeSchema>;

export interface UsageSourceRegistration {
  id: string;
  label: string;
  icon?: string;
  input: ZodType;
  /** Accounts for this scope only. The same key in any scope identifies the same account. */
  discover(scope: UsageScope): Promise<UsageAccount[]>;
  /** Re-reads the login store; never writes it. */
  fetch(input: unknown): Promise<UsageReport>;
}

export function windowFromUsedPct(input: {
  id: string;
  label: string;
  shortLabel?: string;
  summary?: boolean;
  utilizationPct: number | null | undefined;
  resetsAt?: string | null;
  tone?: UsageWindow["tone"];
}): UsageWindow {
  const usedPct = typeof input.utilizationPct === "number" ? input.utilizationPct : null;
  const window: UsageWindow = {
    id: input.id,
    label: input.label,
    usedPct,
    remainingPct: usedPct === null ? null : Math.max(0, 100 - usedPct),
    resetsAt: input.resetsAt ?? null,
  };
  if (input.shortLabel !== undefined) window.shortLabel = input.shortLabel;
  if (input.summary) window.summary = true;
  if (input.tone) window.tone = input.tone;
  return window;
}

/**
 * Numeric provider windows have one identity and vocabulary, independent of response slots.
 * Pass null when the provider omits the duration; reset countdowns are not window lengths.
 * Named API fields (weekly, monthly, etc.) use windowFromUsedPct instead.
 */
export function windowFromReportedDuration(input: {
  durationSeconds: number | null;
  /** Stable quota identity and provider name for a model- or feature-scoped limit. */
  scope?: { id: string; label: string };
  /** Neutral identity and names when the provider does not report a positive duration. */
  unknown: { id: string; label: string; shortLabel: string };
  utilizationPct: number | null | undefined;
  resetsAt?: string | null;
  summary?: boolean;
  tone?: UsageWindow["tone"];
}): UsageWindow {
  const duration = input.durationSeconds;
  const name =
    duration !== null && Number.isFinite(duration) && duration > 0
      ? durationWindowName(duration)
      : input.unknown;
  const scope = input.scope;
  return windowFromUsedPct({
    id: scope ? `${scope.id}:${name.id}` : name.id,
    label: scope ? `${scope.label} · ${name.label}` : name.label,
    shortLabel: scope
      ? `${scope.label}${name.shortLabel ? ` ${name.shortLabel}` : ""}`
      : name.shortLabel,
    utilizationPct: input.utilizationPct,
    resetsAt: input.resetsAt,
    summary: input.summary,
    tone: input.tone,
  });
}

function durationWindowName(seconds: number): { id: string; label: string; shortLabel: string } {
  if (seconds === 604800) return { id: "weekly", label: "Weekly", shortLabel: "wk" };
  const id = seconds === 18000 ? "five_hour" : `${seconds}s`;
  const units = [
    [86400, "day", "d"],
    [3600, "hour", "h"],
    [60, "minute", "m"],
    [1, "second", "s"],
  ] as const;
  const unit = units.find(([size]) => seconds % size === 0) ?? units[units.length - 1]!;
  const amount = seconds / unit[0];
  return { id, label: `${amount}-${unit[1]}`, shortLabel: `${amount}${unit[2]}` };
}

/**
 * The tone scale for anything measured against a known limit, windows and balances alike.
 *
 * Thresholds match `deriveTone` in the app's provider-usage/tone.ts, which is what the
 * client falls back to when a window arrives without a tone. Healthy is "ok" rather than
 * "default" because that is what every provider setting a tone has always sent, and it is
 * what the bars render today below their thresholds.
 */
export function toneFromUsedPct(usedPct: number | null | undefined): UsageWindow["tone"] {
  if (typeof usedPct !== "number") return "default";
  if (usedPct > 90) return "danger";
  if (usedPct >= 70) return "warning";
  return "ok";
}

/**
 * Tone for a balance with no known limit, where a percentage cannot be computed and the
 * only signal is whether anything is left. Prefer `toneFromUsedPct` when a limit exists:
 * this one stays "ok" until the balance is completely spent.
 */
export function balanceToneFromRemaining(
  remaining: number | null | undefined,
): UsageBalance["tone"] {
  if (typeof remaining !== "number") return "default";
  if (remaining <= 0) return "danger";
  return "ok";
}

/** Percentage of a limit consumed, or null when either side is unknown. */
export function usedPctOf(
  used: number | null | undefined,
  limit: number | null | undefined,
): number | null {
  if (typeof used !== "number" || typeof limit !== "number" || limit <= 0) return null;
  return (used / limit) * 100;
}

export function hashAccountKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function unavailable(problem: UsageProblem): UsageReport {
  return { status: "unavailable", problem };
}

export {
  fetchWithAutoProxy,
  isProxyBypassed,
  requestThroughProxy,
  resolveUsageProxyUrl,
  type UsageProxyOptions,
} from "./usage-proxy.js";

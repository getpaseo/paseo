import { z } from "zod";
import type {
  ProviderUsage,
  ProviderUsageBalance,
  ProviderUsageWindow,
} from "../../server/messages.js";
import type { ProviderApiFetch } from "./provider.js";

const PROVIDER_HTTP_TIMEOUT_MS = 15_000;

export const ApiNumberSchema = z.coerce.number().finite();
export const ApiNullableNumberSchema = z.preprocess(
  (value) => (value == null ? null : value),
  ApiNumberSchema.nullable(),
);
export const ApiOptionalStringSchema = z.preprocess(
  (value) => (value == null ? undefined : value),
  z.coerce.string().optional(),
);

export function fetchProviderApi(
  fetchApi: ProviderApiFetch,
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  return fetchApi(input, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(PROVIDER_HTTP_TIMEOUT_MS),
  });
}

export function unavailableUsage(provider: {
  providerId: string;
  displayName: string;
  error?: string | null;
}): ProviderUsage {
  return {
    providerId: provider.providerId,
    displayName: provider.displayName,
    status: provider.error ? "error" : "unavailable",
    planLabel: null,
    windows: [],
    balances: [],
    details: [],
    error: provider.error ?? null,
  };
}

export function windowFromUsedPct(input: {
  id: string;
  label: string;
  utilizationPct: number | null | undefined;
  resetsAt?: string | null;
  tone?: ProviderUsageWindow["tone"];
}): ProviderUsageWindow {
  const usedPct = typeof input.utilizationPct === "number" ? input.utilizationPct : null;
  const window: ProviderUsageWindow = {
    id: input.id,
    label: input.label,
    usedPct,
    remainingPct: usedPct === null ? null : Math.max(0, 100 - usedPct),
    resetsAt: input.resetsAt ?? null,
  };
  if (input.tone) {
    window.tone = input.tone;
  }
  return window;
}

export function balanceToneFromRemaining(
  remaining: number | null | undefined,
): ProviderUsageBalance["tone"] {
  if (typeof remaining !== "number") return "default";
  if (remaining <= 0) return "danger";
  return "ok";
}

export function toIsoStringOrNull(timestampMs: number): string | null {
  const date = new Date(timestampMs);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

import type { UsageInput } from "../shared/input.js";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  fetchWithAutoProxy,
  toneFromUsedPct,
  usedPctOf,
  unavailable,
  type UsageAccount,
  windowFromUsedPct,
  type UsageReport,
  type UsageWindow,
  type UsageBalance,
} from "@getpaseo/plugin/server/usage";

const ApiNumberSchema = z.coerce.number().finite();
const ApiOptionalStringSchema = z.preprocess(
  (value) => (value == null ? undefined : value),
  z.coerce.string().optional(),
);

const GrokUsageResponseSchema = z.object({
  config: z
    .object({
      monthlyLimit: z
        .object({
          val: ApiNumberSchema.optional(),
        })
        .nullish(),
      used: z
        .object({
          val: ApiNumberSchema.optional(),
        })
        .nullish(),
      creditUsagePercent: ApiNumberSchema.optional(),
      currentPeriod: z
        .object({
          type: ApiOptionalStringSchema,
          end: ApiOptionalStringSchema,
        })
        .nullish(),
    })
    .nullish(),
  usage: z
    .object({
      creditUsage: ApiNumberSchema.optional(),
    })
    .nullish(),
});

/** Resolve a Grok CLI token from ~/.grok/auth.json (legacy or current nested shape). */
export function extractGrokTokenFromAuth(auth: unknown): string | null {
  if (auth == null || typeof auth !== "object" || Array.isArray(auth)) return null;
  const record = auth as Record<string, unknown>;

  const topLevel = record["access_token"];
  if (typeof topLevel === "string" && topLevel.length > 0) {
    return topLevel;
  }

  const entries = Object.entries(record);
  const preferred = entries.filter(([key]) => key.startsWith("https://auth.x.ai::"));
  const candidates = preferred.length > 0 ? preferred : entries;

  for (const [, value] of candidates) {
    if (value == null || typeof value !== "object" || Array.isArray(value)) continue;
    const nestedKey = (value as Record<string, unknown>)["key"];
    if (typeof nestedKey === "string" && nestedKey.length > 0) {
      return nestedKey;
    }
  }

  return null;
}

function grokCreditBalance(response: z.infer<typeof GrokUsageResponseSchema>): UsageBalance | null {
  const limit = response.config?.monthlyLimit?.val ?? null;
  const used = response.config?.used?.val ?? response.usage?.creditUsage ?? null;
  if (limit === null && used === null) return null;
  return {
    // Only the named monthly allowance establishes a monthly credit bucket.
    id: limit === null ? "credits" : "monthly_credits",
    label: limit === null ? "Credits" : "Monthly credits",
    used,
    remaining: limit !== null && used !== null ? Math.max(0, limit - used) : null,
    limit,
    unit: "credits",
    tone: toneFromUsedPct(usedPctOf(used, limit)),
  };
}

function grokUsageWindow(response: z.infer<typeof GrokUsageResponseSchema>): UsageWindow | null {
  const percent = response.config?.creditUsagePercent;
  if (typeof percent !== "number") return null;
  const period = response.config?.currentPeriod;
  const names = {
    USAGE_PERIOD_TYPE_WEEKLY: { id: "weekly", label: "Weekly", shortLabel: "wk" },
    USAGE_PERIOD_TYPE_MONTHLY: { id: "monthly", label: "Monthly", shortLabel: "mo" },
  };
  // An absent or unfamiliar enum does not establish a monthly duration.
  const name = names[period?.type as keyof typeof names] ?? {
    id: `period:${period?.type || "unknown"}`,
    label: period?.type || "Current period",
    shortLabel: "",
  };
  return windowFromUsedPct({
    ...name,
    utilizationPct: percent,
    resetsAt: period?.end ?? null,
    tone: toneFromUsedPct(percent),
  });
}

export async function fetchUsage(
  input: UsageInput,
  fetchApi: typeof fetch = fetchWithAutoProxy,
): Promise<UsageReport> {
  const token = await readToken(input);
  if (!token) throw new Error("Grok login store no longer exists");

  // The Grok CLI's /usage uses ?format=credits; without it, unified-billing accounts
  // get a zeroed legacy monthly shape (monthlyLimit.val 0) instead of real usage.
  const res = await fetchApi("https://cli-chat-proxy.grok.com/v1/billing?format=credits", {
    signal: AbortSignal.timeout(15_000),
    headers: {
      Authorization: `Bearer ${token}`,
      "X-XAI-Token-Auth": "xai-grok-cli",
      Accept: "application/json",
    },
  });

  if (res.status === 401 || res.status === 403)
    return unavailable({ kind: "rejected", status: res.status });
  if (!res.ok) throw new Error(`Grok usage API returned ${res.status}`);

  const resp = GrokUsageResponseSchema.parse(await res.json());
  const balance = grokCreditBalance(resp);
  const window = grokUsageWindow(resp);

  return {
    status: "available",
    planLabel: undefined,
    windows: window ? [window] : [],
    balances: balance ? [balance] : [],
    details: [],
  };
}

async function readToken(input: UsageInput): Promise<string | undefined> {
  if (input.store === "env") return process.env[input.locator];
  try {
    return (
      extractGrokTokenFromAuth(JSON.parse(await fs.readFile(input.locator, "utf8"))) ?? undefined
    );
  } catch {
    return undefined;
  }
}
export async function discover(): Promise<UsageAccount[]> {
  const candidates: UsageInput[] = ["GROK_API_KEY", "GROK_TOKEN"].map((locator) => ({
    store: "env",
    locator,
  }));
  candidates.push({ store: "file", locator: join(homedir(), ".grok", "auth.json") });
  for (const input of candidates) if (await readToken(input)) return [{ key: "default", input }];
  return [];
}

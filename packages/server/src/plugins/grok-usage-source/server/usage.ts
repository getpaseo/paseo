import type { UsageInput } from "../shared/input.js";
import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  toneFromUsedPct,
  usedPctOf,
  unavailableUsage,
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

function grokMonthlyCreditBalance(
  response: z.infer<typeof GrokUsageResponseSchema>,
): UsageBalance | null {
  const limit = response.config?.monthlyLimit?.val ?? null;
  const used = response.config?.used?.val ?? response.usage?.creditUsage ?? null;
  if (limit === null && used === null) return null;
  return {
    id: "monthly_credits",
    label: "Monthly credits",
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
  const weekly = (period?.type ?? "").toUpperCase().includes("WEEKLY");
  return windowFromUsedPct({
    id: weekly ? "weekly" : "monthly",
    label: weekly ? "Weekly" : "Monthly",
    utilizationPct: percent,
    resetsAt: period?.end ?? null,
    tone: toneFromUsedPct(percent),
  });
}

export async function fetchUsage(
  input: UsageInput,
  fetchApi: typeof fetch = fetch,
): Promise<UsageReport> {
  void input;
  const homeDir = homedir();

  async function readGrokToken(): Promise<string | null> {
    // homeDir override is for tests: Windows os.homedir() ignores $HOME (uses USERPROFILE).
    const path = join(homeDir ?? homedir(), ".grok", "auth.json");
    if (!existsSync(path)) return null;
    try {
      return extractGrokTokenFromAuth(JSON.parse(await fs.readFile(path, "utf8")));
    } catch {
      return null;
    }
  }

  const token = process.env["GROK_API_KEY"] || process.env["GROK_TOKEN"] || (await readGrokToken());

  if (!token) return unavailableUsage();

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

  if (!res.ok) {
    return unavailableUsage();
  }

  const resp = GrokUsageResponseSchema.parse(await res.json());
  const balance = grokMonthlyCreditBalance(resp);
  const window = grokUsageWindow(resp);
  if (window) window.headline = true;

  return {
    account: { key: "default" },
    status: "available",
    planLabel: undefined,
    windows: window ? [window] : [],
    balances: balance ? [balance] : [],
    details: [],
  };
}

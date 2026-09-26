import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  balanceToneFromRemaining,
  toneFromUsedPct,
  windowFromUsedPct,
  type UsageReport,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";
import { z } from "zod";
import type { CodexUsageInput } from "../shared/input.js";

const authSchema = z.object({
  tokens: z
    .object({ access_token: z.string().optional(), account_id: z.string().optional() })
    .optional(),
});
const number = z.coerce.number().finite();
const windowSchema = z.object({ used_percent: number.optional(), reset_at: number.optional() });
const responseSchema = z.object({
  plan_type: z.string().optional(),
  email: z.string().optional(),
  rate_limit: z
    .object({ primary_window: windowSchema.nullish(), secondary_window: windowSchema.nullish() })
    .nullish(),
  code_review_rate_limit: z.object({ primary_window: windowSchema.nullish() }).nullish(),
  credits: z.object({ balance: number.optional() }).nullish(),
});

async function readAuth(
  input: CodexUsageInput,
): Promise<{ token: string; accountId?: string } | null> {
  if ("accessToken" in input) return { token: input.accessToken, accountId: input.accountId };
  const candidates =
    "codexHome" in input
      ? [join(input.codexHome, "auth.json")]
      : [
          ...(process.env["CODEX_HOME"] ? [join(process.env["CODEX_HOME"], "auth.json")] : []),
          join(homedir(), ".config", "codex", "auth.json"),
          join(homedir(), ".codex", "auth.json"),
        ];
  for (const path of candidates) {
    try {
      const auth = authSchema.parse(JSON.parse(await readFile(path, "utf8")));
      if (auth.tokens?.access_token)
        return { token: auth.tokens.access_token, accountId: auth.tokens.account_id };
    } catch {
      continue;
    }
  }
  return null;
}

function usageWindow(
  id: string,
  label: string,
  value: z.infer<typeof windowSchema> | null | undefined,
  headline = false,
): UsageWindow | null {
  if (!value) return null;
  const usedPct = value.used_percent ?? 0;
  return windowFromUsedPct({
    id,
    label,
    utilizationPct: usedPct,
    resetsAt: value.reset_at != null ? new Date(value.reset_at * 1000).toISOString() : null,
    tone: toneFromUsedPct(usedPct),
    headline,
  });
}

export async function fetchUsage(
  input: CodexUsageInput,
  fetchApi: typeof fetch = fetch,
): Promise<UsageReport> {
  const auth = await readAuth(input);
  if (!auth) return { account: { key: "default" }, status: "unavailable", windows: [] };
  const key = auth.accountId ?? createHash("sha256").update(auth.token).digest("hex");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.token}`,
    Accept: "application/json",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
  };
  if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;
  const response = await fetchApi("https://chatgpt.com/backend-api/wham/usage", {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403)
    return { account: { key }, status: "unavailable", windows: [] };
  if (!response.ok) throw new Error(`Codex usage API returned ${response.status}`);
  const text = await response.text();
  if (text.trim().startsWith("<")) return { account: { key }, status: "unavailable", windows: [] };
  const usage = responseSchema.parse(JSON.parse(text));
  const windows = [
    usageWindow("session", "Session", usage.rate_limit?.primary_window, true),
    usageWindow("weekly", "Weekly", usage.rate_limit?.secondary_window),
    usageWindow("code_review", "Code review", usage.code_review_rate_limit?.primary_window),
  ].filter((window): window is UsageWindow => window !== null);
  const balance = usage.credits?.balance;
  return {
    account: { key, ...(usage.email ? { label: usage.email } : {}) },
    status: "available",
    planLabel: usage.plan_type,
    windows,
    balances:
      balance === undefined
        ? []
        : [
            {
              id: "credits",
              label: "Credits",
              remaining: balance,
              unit: "usd",
              tone: balanceToneFromRemaining(balance),
            },
          ],
    details: [],
  };
}

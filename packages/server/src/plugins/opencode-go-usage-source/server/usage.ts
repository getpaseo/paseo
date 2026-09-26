import { createHash } from "node:crypto";
import { z } from "zod";
import {
  toneFromUsedPct,
  windowFromUsedPct,
  type UsageReport,
} from "@getpaseo/plugin/server/usage";
import type { Input } from "../shared/input.js";

const windowSchema = z
  .object({ usagePercent: z.number().finite(), resetInSec: z.number().finite().optional() })
  .passthrough();
const responseSchema = z.object({
  rollingUsage: windowSchema.optional(),
  weeklyUsage: windowSchema.optional(),
  monthlyUsage: windowSchema.optional(),
});

export async function fetchUsage(
  input: Input,
  fetchApi: typeof fetch = fetch,
): Promise<UsageReport> {
  const key = createHash("sha256").update(input.apiKey).digest("hex");
  const response = await fetchApi("https://opencode.ai/zen/go/v1/usage", {
    headers: { Authorization: `Bearer ${input.apiKey}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403)
    return { account: { key }, status: "unavailable", windows: [] };
  if (!response.ok) throw new Error(`OpenCode Go usage API returned ${response.status}`);
  const data = responseSchema.parse(await response.json());
  const now = Date.now();
  const windows = (
    [
      ["rolling", "Rolling", data.rollingUsage],
      ["weekly", "Weekly", data.weeklyUsage],
      ["monthly", "Monthly", data.monthlyUsage],
    ] as const
  ).flatMap(([id, label, value]) =>
    value
      ? [
          windowFromUsedPct({
            id,
            label,
            utilizationPct: value.usagePercent,
            resetsAt:
              value.resetInSec === undefined
                ? null
                : new Date(now + value.resetInSec * 1000).toISOString(),
            tone: toneFromUsedPct(value.usagePercent),
            headline: id === "rolling",
          }),
        ]
      : [],
  );
  return { account: { key }, status: "available", planLabel: "Go", windows };
}

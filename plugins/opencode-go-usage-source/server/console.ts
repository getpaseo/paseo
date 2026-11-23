import { z } from "zod";
import {
  toneFromUsedPct,
  unavailable,
  windowFromUsedPct,
  type UsageReport,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";

// The endpoint the Console's own Go page reads. It is not publicly documented.
const STATUS_URL = "https://opencode.ai/console/api/go/status";
const GO_PRODUCTS = new Set(["go", "go-plus", "go-teams"]);
export const NO_SUBSCRIPTION = unavailable({
  kind: "no_quota",
  detail: "No active OpenCode Go subscription",
});

const amount = z.union([z.string(), z.number()]).transform(Number);
const meterSchema = z.object({
  limitMicroCents: amount,
  usedMicroCents: amount,
  resetsAt: z.iso.datetime(),
});
const statusSchema = z.object({
  product: z.string().nullish(),
  // An ended or refunded subscription keeps its product and sends no access.
  access: z
    .object({
      meters: z.object({
        fiveHour: z.unknown().optional(),
        week: z.unknown().optional(),
        month: z.unknown().optional(),
      }),
    })
    .nullish(),
});

const METERS = [
  ["fiveHour", "rolling", "Rolling", ""],
  ["week", "weekly", "Weekly", "wk"],
  ["month", "monthly", "Monthly", "mo"],
] as const;

/**
 * Reads the Go meters the Console shows. A sign-in names its organization; an API key belongs to
 * one workspace and sends none. Throws on failures that say nothing about the login.
 */
export async function readConsoleGo(
  login: { token: string; orgID?: string },
  fetchApi: typeof fetch,
  timeoutMs = 15_000,
): Promise<UsageReport> {
  const response = await fetchApi(STATUS_URL, {
    headers: {
      Authorization: `Bearer ${login.token}`,
      Accept: "application/json",
      ...(login.orgID ? { "x-org-id": login.orgID } : {}),
    },
    // The token goes to the Console origin only.
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 401 || response.status === 403)
    return unavailable({ kind: "rejected", status: response.status, refreshedBy: "opencode" });
  if (!response.ok) throw new Error(`OpenCode Console Go status returned ${response.status}`);
  const status = statusSchema.parse(await response.json());
  if (!status.product || !GO_PRODUCTS.has(status.product) || !status.access) return NO_SUBSCRIPTION;
  const windows = METERS.flatMap(([meter, id, label, shortLabel]): UsageWindow[] => {
    const parsed = meterSchema.safeParse(status.access?.meters[meter]);
    if (!parsed.success) return [];
    const { limitMicroCents: limit, usedMicroCents: used, resetsAt } = parsed.data;
    if (!(limit > 0) || !(used >= 0)) return [];
    const usedPct = Math.min(100, (used / limit) * 100);
    return [
      windowFromUsedPct({
        id,
        label,
        shortLabel,
        utilizationPct: usedPct,
        resetsAt,
        tone: toneFromUsedPct(usedPct),
      }),
    ];
  });
  if (!windows.length) throw new Error("OpenCode Console Go status has no readable meters");
  return { status: "available", planLabel: "Go", windows };
}

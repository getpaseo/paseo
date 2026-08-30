import type { Logger } from "pino";
import { z } from "zod";
import type { ProviderUsage, ProviderUsageWindow } from "../../../server/messages.js";
import { execCommand } from "../../../utils/spawn.js";
import { toIsoStringOrNull, toneFromUsedPct, usedPctOf, windowFromUsedPct } from "../usage.js";

const DEFAULT_OMP_COMMAND: [string, ...string[]] = [process.env.OMP_COMMAND ?? "omp"];
const OMP_USAGE_TIMEOUT_MS = 15_000;
// The z.ai report embeds hourly model-usage history; keep headroom for it.
const OMP_USAGE_MAX_BUFFER = 10 * 1024 * 1024;

const OmpUsageAmountSchema = z
  .object({
    used: z.number().nullish(),
    limit: z.number().nullish(),
    remaining: z.number().nullish(),
    usedFraction: z.number().nullish(),
    remainingFraction: z.number().nullish(),
    unit: z.string().nullish(),
  })
  .passthrough();

const OmpUsageWindowSchema = z
  .object({
    id: z.string().optional(),
    label: z.string().optional(),
    resetsAt: z.number().nullish(),
  })
  .passthrough();

const OmpUsageLimitSchema = z
  .object({
    id: z.string(),
    label: z.string().nullish(),
    scope: z.object({ windowId: z.string().nullish() }).passthrough().nullish(),
    window: OmpUsageWindowSchema.nullish(),
    amount: OmpUsageAmountSchema.nullish(),
  })
  .passthrough();

const OmpUsageReportSchema = z
  .object({
    provider: z.string(),
    fetchedAt: z.number().nullish(),
    limits: z.array(OmpUsageLimitSchema).nullish(),
    metadata: z.object({ planType: z.string().nullish() }).passthrough().nullish(),
  })
  .passthrough();

const OmpUsageOutputSchema = z
  .object({ reports: z.array(OmpUsageReportSchema).nullish() })
  .passthrough();

export type OmpUsageReport = z.infer<typeof OmpUsageReportSchema>;
export type OmpUsageLimit = z.infer<typeof OmpUsageLimitSchema>;

/** Structurally `execCommand` from utils/spawn; injectable for tests. */
export type OmpUsageExec = (
  command: string,
  args: string[],
  options?: { timeout?: number; maxBuffer?: number },
) => Promise<{ stdout: string; stderr: string }>;

export interface OmpUsageRunnerOptions {
  logger: Logger;
  command?: [string, ...string[]];
  exec?: OmpUsageExec;
}

/**
 * Reads one provider's usage report from the OMP CLI (`omp usage --json`).
 * Returns null when OMP is missing, not logged in for the provider, or the
 * output cannot be parsed — callers decide what fallback to show.
 */
export class OmpUsageRunner {
  private readonly command: [string, ...string[]];
  private readonly exec: OmpUsageExec;
  private readonly logger: Logger;

  constructor(options: OmpUsageRunnerOptions) {
    this.command = options.command ?? DEFAULT_OMP_COMMAND;
    this.exec = options.exec ?? execCommand;
    this.logger = options.logger;
  }

  async fetchReport(providerId: string): Promise<OmpUsageReport | null> {
    const [command, ...prefixArgs] = this.command;
    try {
      const { stdout } = await this.exec(
        command,
        [...prefixArgs, "usage", "--json", "--provider", providerId],
        { timeout: OMP_USAGE_TIMEOUT_MS, maxBuffer: OMP_USAGE_MAX_BUFFER },
      );
      const parsed = OmpUsageOutputSchema.parse(JSON.parse(stdout));
      // `omp usage --json` currently reports one aggregated record per
      // provider even with several authenticated accounts. If OMP starts
      // emitting per-account reports, this must resolve the active
      // credential instead of the first match.
      return parsed.reports?.find((report) => report.provider === providerId) ?? null;
    } catch (error) {
      this.logger.debug({ err: error, providerId }, "OMP usage fetch failed");
      return null;
    }
  }
}

/**
 * Maps an OMP usage report into the Paseo provider-usage shape. Returns null
 * when the report carries no usable window so callers can fall back.
 */
export function providerUsageFromOmpReport(input: {
  report: OmpUsageReport;
  providerId: string;
  displayName: string;
}): ProviderUsage | null {
  const windows: ProviderUsageWindow[] = [];
  for (const limit of input.report.limits ?? []) {
    const amount = limit.amount;
    const usedPct =
      typeof amount?.usedFraction === "number" && Number.isFinite(amount.usedFraction)
        ? amount.usedFraction * 100
        : usedPctOf(amount?.used, amount?.limit);
    if (usedPct === null) continue;
    windows.push(
      windowFromUsedPct({
        id: limit.id,
        label: limit.label ?? limit.id,
        utilizationPct: usedPct,
        resetsAt:
          typeof limit.window?.resetsAt === "number"
            ? toIsoStringOrNull(limit.window.resetsAt)
            : null,
        tone: toneFromUsedPct(usedPct),
      }),
    );
  }
  if (windows.length === 0) return null;

  return {
    providerId: input.providerId,
    displayName: input.displayName,
    status: "available",
    planLabel: input.report.metadata?.planType ?? null,
    sourceLabel: "Oh My Pi",
    fetchedAt:
      typeof input.report.fetchedAt === "number" ? toIsoStringOrNull(input.report.fetchedAt) : null,
    windows,
    balances: [],
    details: [],
    error: null,
  };
}

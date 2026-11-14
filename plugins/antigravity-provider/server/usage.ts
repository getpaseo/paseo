import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { execCommand, type UsageSourceRegistration } from "@getpaseo/plugin/server";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";
import {
  balanceToneFromRemaining,
  toneFromUsedPct,
  unavailable,
  windowFromUsedPct,
  type UsageBalance,
  type UsageReport,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";
import { accountLocatorKey, resolveAntigravityDataDir } from "./internal/data-dir.js";

const USAGE_TIMEOUT_MS = 18_000;

const inputSchema = z
  .object({
    locatorId: z.string().min(1),
    dataDir: z.string().min(1),
  })
  .strict();

const usageBucketSchema = z.object({
  id: z.string().optional(),
  name: z.string().default(""),
  window: z.string().optional(),
  remaining_fraction: z.number().nullable().optional(),
  reset_time: z.string().nullable().optional(),
});

const usageGroupSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  buckets: z.array(usageBucketSchema).default([]),
});

const usageCommandOutputSchema = z.object({
  status: z.string().optional(),
  response: z.string().optional(),
  error: z.string().optional(),
  command: z
    .object({
      name: z.string().optional(),
      data: z
        .object({
          plan: z.string().optional(),
          tier: z.string().optional(),
          groups: z.array(usageGroupSchema).optional(),
        })
        .optional(),
    })
    .optional(),
});

const creditsCommandOutputSchema = z.object({
  status: z.string().optional(),
  response: z.string().optional(),
  error: z.string().optional(),
  command: z
    .object({
      name: z.string().optional(),
      data: z
        .object({
          remaining_credits: z.number().nullable().optional(),
        })
        .optional(),
    })
    .optional(),
});

const LOGIN_STORE_MARKERS = [
  ["jetski_state.pbtxt"],
  ["cache", "onboarding.json"],
  ["oauth_creds.json"],
] as const;

export class Usage {
  private defaultLaunch: ProviderLaunch | null = null;
  private readonly launches = new Map<string, ProviderLaunch>();
  private readonly tiers = new Map<string, string>();

  rememberLaunch(
    launch: ProviderLaunch,
    sessionEnv?: Readonly<Record<string, string>>,
  ): { locatorId: string; dataDir: string } {
    if (!sessionEnv) {
      this.defaultLaunch = launch;
    }
    const mergedEnv = sessionEnv ? { ...launch.env, ...sessionEnv } : { ...launch.env };
    const dataDir = resolveAntigravityDataDir(mergedEnv);
    const locatorId = accountLocatorKey(dataDir, mergedEnv);
    this.launches.set(locatorId, {
      command: launch.command,
      args: [...launch.args],
      env: mergedEnv,
    });
    return { locatorId, dataDir };
  }

  rememberTier(locatorId: string, tierName: string | null | undefined): void {
    const trimmed = tierName?.trim();
    if (trimmed) {
      this.tiers.set(locatorId, trimmed);
    }
  }

  registration(): UsageSourceRegistration {
    return {
      id: "antigravity",
      label: "Antigravity",
      icon: "icon.svg",
      input: inputSchema,
      discover: async (scope) => {
        if (scope.kind === "session" && scope.provider !== "antigravity") {
          return [];
        }
        const baseEnv = this.defaultLaunch?.env ?? processEnvRecord();
        const effectiveEnv =
          scope.kind === "session" ? { ...baseEnv, ...scope.env } : { ...baseEnv };
        const dataDir = resolveAntigravityDataDir(effectiveEnv);
        const locatorId = accountLocatorKey(dataDir, effectiveEnv);

        if (!(await hasAntigravityLogin(dataDir, effectiveEnv))) {
          return [];
        }

        const knownLaunch = this.launches.get(locatorId) ?? this.defaultLaunch;
        const command = knownLaunch?.command ?? "agy";
        if (!(await isCommandResolvable(command, effectiveEnv))) {
          return [];
        }

        if (!this.launches.has(locatorId)) {
          this.launches.set(locatorId, {
            command,
            args: knownLaunch ? [...knownLaunch.args] : [],
            env: effectiveEnv,
          });
        }

        return [
          {
            key: locatorId,
            harness: "Antigravity",
            input: { locatorId, dataDir },
          },
        ];
      },
      fetch: async (rawInput) => {
        const { locatorId, dataDir } = inputSchema.parse(rawInput);
        const launch = this.resolveLaunch(locatorId, dataDir);
        const env: NodeJS.ProcessEnv = {
          ...launch.env,
          ANTIGRAVITY_EXECUTABLE_DATA_DIR: launch.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR ?? dataDir,
          NO_COLOR: "1",
        };

        const [usageResult, creditsResult] = await Promise.allSettled([
          execCommand(launch.command, [...launch.args, "-p", "/usage", "--output-format", "json"], {
            env,
            shell: false,
            timeout: USAGE_TIMEOUT_MS,
          }),
          execCommand(
            launch.command,
            [...launch.args, "-p", "/credits", "--output-format", "json"],
            {
              env,
              shell: false,
              timeout: USAGE_TIMEOUT_MS,
            },
          ),
        ]);

        if (usageResult.status === "rejected") {
          return classifyUsageFailure(usageResult.reason);
        }

        const parsedUsage = parseUsageStdout(usageResult.value.stdout, usageResult.value.stderr);
        if ("report" in parsedUsage) {
          return parsedUsage.report;
        }

        const balances =
          creditsResult.status === "fulfilled"
            ? parseCreditsStdout(creditsResult.value.stdout)
            : [];

        const planLabel = parsedUsage.planLabel ?? this.tiers.get(locatorId);
        if (parsedUsage.windows.length === 0 && balances.length === 0) {
          return unavailable({
            kind: "no_quota",
            detail: "Antigravity reported no quota windows or credit balances.",
          });
        }

        return {
          status: "available",
          ...(planLabel ? { planLabel } : {}),
          windows: parsedUsage.windows,
          ...(balances.length > 0 ? { balances } : {}),
        };
      },
    };
  }

  private resolveLaunch(locatorId: string, dataDir: string): ProviderLaunch {
    const remembered = this.launches.get(locatorId);
    if (remembered) return remembered;
    if (this.defaultLaunch) {
      return {
        command: this.defaultLaunch.command,
        args: [...this.defaultLaunch.args],
        env: { ...this.defaultLaunch.env, ANTIGRAVITY_EXECUTABLE_DATA_DIR: dataDir },
      };
    }
    return {
      command: "agy",
      args: [],
      env: { ...processEnvRecord(), ANTIGRAVITY_EXECUTABLE_DATA_DIR: dataDir },
    };
  }
}

async function hasAntigravityLogin(
  dataDir: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  if (env.AGY_ADC_AUTH?.trim() || env.AGY_TEST_USAGE?.trim()) {
    return true;
  }
  for (const segments of LOGIN_STORE_MARKERS) {
    if (await isExistingFile(path.join(dataDir, ...segments))) {
      return true;
    }
  }
  return false;
}

async function isExistingFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function isCommandResolvable(
  command: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  if (command.includes("/") || command.includes("\\")) {
    return isExecutableOrFile(command);
  }
  const rawPath = env.PATH ?? process.env.PATH ?? "";
  const extensions =
    process.platform === "win32"
      ? (env.PATHEXT ?? process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];
  for (const dir of rawPath.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      if (await isExecutableOrFile(path.join(dir, `${command}${ext}`))) {
        return true;
      }
    }
  }
  return false;
}

async function isExecutableOrFile(candidate: string): Promise<boolean> {
  try {
    await access(candidate, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

function parseUsageStdout(
  stdout: string,
  stderr: string,
): { windows: UsageWindow[]; planLabel?: string } | { report: UsageReport } {
  const trimmed = stdout.trim();
  const combined = [trimmed, stderr.trim()].filter(Boolean).join("\n");
  if (/AGY_ERROR:/i.test(combined)) {
    return { report: classifyCombinedText(combined) };
  }

  const jsonPayload = tryParseJson(trimmed);
  if (jsonPayload !== undefined) {
    const fromJson = parseUsageJsonPayload(jsonPayload, combined);
    if (fromJson) return fromJson;
  }

  if (trimmed.includes("\t")) {
    return { windows: parseUsageTsv(trimmed) };
  }
  if (!trimmed) {
    return { windows: [] };
  }
  return { report: classifyCombinedText(combined) };
}

function parseUsageJsonPayload(
  jsonPayload: unknown,
  combined: string,
): { windows: UsageWindow[]; planLabel?: string } | { report: UsageReport } | null {
  const parsed = usageCommandOutputSchema.safeParse(jsonPayload);
  if (!parsed.success) return null;

  if (parsed.data.status && parsed.data.status !== "SUCCESS") {
    const errorText = extractUsageErrorText(parsed.data, combined);
    return { report: classifyCombinedText(errorText) };
  }
  const planLabel = extractUsagePlanLabel(parsed.data.command?.data);
  const windows = extractUsageJsonWindows(parsed.data);
  return planLabel ? { windows, planLabel } : { windows };
}

function extractUsageErrorText(
  data: z.infer<typeof usageCommandOutputSchema>,
  fallback: string,
): string {
  return data.error?.trim() || data.response?.trim() || fallback;
}

function extractUsagePlanLabel(
  data: NonNullable<z.infer<typeof usageCommandOutputSchema>["command"]>["data"],
): string | undefined {
  return data?.tier?.trim() || data?.plan?.trim() || undefined;
}

function extractUsageJsonWindows(data: z.infer<typeof usageCommandOutputSchema>): UsageWindow[] {
  const groups = data.command?.data?.groups;
  if (groups && groups.length > 0) return buildWindowsFromGroups(groups);
  if (data.response) return parseUsageTsv(data.response);
  return [];
}

function buildWindowsFromGroups(
  groups: ReadonlyArray<z.infer<typeof usageGroupSchema>>,
): UsageWindow[] {
  const windows: UsageWindow[] = [];
  let summaryCount = 0;

  for (const group of groups) {
    const shortGroup = shortenGroupName(group.name);
    const orderedBuckets = [...group.buckets].sort(
      (a, b) => bucketWindowSortRank(a) - bucketWindowSortRank(b),
    );
    const hasFiveHour = orderedBuckets.some((bucket) => isFiveHourBucket(bucket));

    orderedBuckets.forEach((bucket, index) => {
      const usedPct =
        typeof bucket.remaining_fraction === "number" && Number.isFinite(bucket.remaining_fraction)
          ? roundPct(clamp(0, 100, (1 - clamp(0, 1, bucket.remaining_fraction)) * 100))
          : null;
      const { windowLabel, shortSuffix } = describeBucketWindow(bucket);
      const isPrimary = isFiveHourBucket(bucket) || (!hasFiveHour && index === 0);
      const summary = isPrimary && summaryCount < 2;
      if (summary) summaryCount += 1;

      const id =
        bucket.id?.trim() ||
        `${slugify(group.name)}-${slugify(bucket.window || bucket.name || String(index))}`;

      windows.push(
        windowFromUsedPct({
          id,
          label: `${group.name} · ${windowLabel}`,
          shortLabel: shortSuffix ? `${shortGroup} ${shortSuffix}` : shortGroup,
          summary,
          utilizationPct: usedPct,
          resetsAt: normalizeIsoTimestamp(bucket.reset_time),
          tone: toneFromUsedPct(usedPct),
        }),
      );
    });
  }

  return windows;
}

function parseUsageTsv(text: string): UsageWindow[] {
  const grouped = new Map<string, Array<z.infer<typeof usageBucketSchema>>>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const [groupName, bucketName, remainingText, resetTime] = line.split("\t");
    if (!groupName || !bucketName || !remainingText) continue;
    const pctMatch = /^(\d+(?:\.\d+)?)%$/.exec(remainingText.trim());
    if (!pctMatch) continue;
    const remainingFraction = clamp(0, 1, Number(pctMatch[1]) / 100);
    const list = grouped.get(groupName) ?? [];
    list.push({
      name: bucketName.trim(),
      window: inferWindowCode(bucketName),
      remaining_fraction: remainingFraction,
      reset_time: resetTime?.trim() || null,
    });
    grouped.set(groupName, list);
  }
  return buildWindowsFromGroups(
    [...grouped.entries()].map(([name, buckets]) => ({ name, buckets })),
  );
}

function parseCreditsStdout(stdout: string): UsageBalance[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];

  let remainingCredits: number | undefined;
  const jsonPayload = tryParseJson(trimmed);
  if (jsonPayload !== undefined) {
    const parsed = creditsCommandOutputSchema.safeParse(jsonPayload);
    if (
      parsed.success &&
      typeof parsed.data.command?.data?.remaining_credits === "number" &&
      Number.isFinite(parsed.data.command.data.remaining_credits)
    ) {
      remainingCredits = parsed.data.command.data.remaining_credits;
    } else if (parsed.success && parsed.data.response) {
      remainingCredits = parseCreditsTsv(parsed.data.response);
    }
  } else {
    remainingCredits = parseCreditsTsv(trimmed);
  }

  if (remainingCredits === undefined || remainingCredits <= 0) return [];

  return [
    {
      id: "credits",
      label: "AI Credits",
      remaining: remainingCredits,
      unit: "credits",
      tone: balanceToneFromRemaining(remainingCredits),
    },
  ];
}

function parseCreditsTsv(text: string): number | undefined {
  for (const line of text.split(/\r?\n/)) {
    const match = /^Remaining credits\t(-?\d+(?:\.\d+)?)$/i.exec(line.trim());
    if (match) return Number(match[1]);
  }
  return undefined;
}

function classifyUsageFailure(error: unknown): UsageReport {
  const detail = error instanceof Error ? error.message : String(error);
  const stderr =
    typeof error === "object" && error && "stderr" in error ? String(error.stderr) : "";
  const stdout =
    typeof error === "object" && error && "stdout" in error ? String(error.stdout) : "";
  return classifyCombinedText(
    [stdout.trim(), stderr.trim(), detail.trim()].filter(Boolean).join("\n"),
  );
}

function classifyCombinedText(combined: string): UsageReport {
  if (
    /not logged in|sign in|log in|authentication required|UNAUTHENTICATED|auth_required|invalid_grant|\b401\b/i.test(
      combined,
    )
  ) {
    return unavailable({ kind: "rejected", status: 401, refreshedBy: "agy" });
  }
  if (/PERMISSION_DENIED|\b403\b/i.test(combined)) {
    return unavailable({ kind: "rejected", status: 403, refreshedBy: "agy" });
  }
  const agyErrorMatch = /AGY_ERROR:\s*\{[^}]*"short_error"\s*:\s*"([^"]+)"/i.exec(combined);
  const clean =
    agyErrorMatch?.[1] ??
    (combined.split(/\r?\n/)[0]?.trim() || "Failed to read Antigravity usage");
  return { status: "error", error: clean };
}

function shortenGroupName(name: string): string {
  if (/^gemini\b/i.test(name)) return "Gemini";
  if (/claude.*gpt|gpt.*claude|third[- ]party|^3p\b/i.test(name)) return "Claude/GPT";
  if (/^claude\b/i.test(name)) return "Claude";
  return name.replace(/\s+models?$/i, "").trim() || name;
}

function isFiveHourBucket(bucket: z.infer<typeof usageBucketSchema>): boolean {
  return bucket.window === "5h" || /five[- ]hour|\b5[- ]?h(?:our)?\b/i.test(bucket.name);
}

function bucketWindowSortRank(bucket: z.infer<typeof usageBucketSchema>): number {
  const windowCode = bucket.window?.trim().toLowerCase() || inferWindowCode(bucket.name);
  if (windowCode === "5h") return 0;
  if (windowCode === "daily") return 1;
  if (windowCode === "weekly") return 2;
  if (windowCode === "monthly") return 3;
  return 4;
}

function describeBucketWindow(bucket: z.infer<typeof usageBucketSchema>): {
  windowLabel: string;
  shortSuffix: string;
} {
  const windowCode = bucket.window?.trim().toLowerCase() || inferWindowCode(bucket.name);
  if (windowCode === "5h") return { windowLabel: "5-hour", shortSuffix: "5h" };
  if (windowCode === "weekly") return { windowLabel: "Weekly", shortSuffix: "wk" };
  if (windowCode === "daily") return { windowLabel: "Daily", shortSuffix: "1d" };
  if (windowCode === "monthly") return { windowLabel: "Monthly", shortSuffix: "mo" };
  const cleaned = bucket.name.replace(/\s*limit\s*remaining$/i, "").trim() || "Quota";
  return { windowLabel: cleaned, shortSuffix: bucket.window?.trim() || "" };
}

function inferWindowCode(name: string): string | undefined {
  if (/five[- ]hour|\b5[- ]?h(?:our)?\b/i.test(name)) return "5h";
  if (/weekly|\b7[- ]?d(?:ay)?\b/i.test(name)) return "weekly";
  if (/daily|\b24[- ]?h(?:our)?\b/i.test(name)) return "daily";
  if (/monthly|\b30[- ]?d(?:ay)?\b/i.test(name)) return "monthly";
  return undefined;
}

function normalizeIsoTimestamp(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function tryParseJson(text: string): unknown {
  if (!text.startsWith("{")) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "window"
  );
}

function clamp(min: number, max: number, value: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundPct(value: number): number {
  return Math.round(value * 10) / 10;
}

function processEnvRecord(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

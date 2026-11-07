import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { UsageSourceRegistration } from "@getpaseo/plugin/server";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";
import {
  hashAccountKey,
  toneFromUsedPct,
  unavailable,
  windowFromReportedDuration,
  type UsageBalance,
  type UsageReport,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";
import { probe } from "./process.js";
import { AntigravityError } from "./wire.js";

const FIVE_HOURS_SECONDS = 18_000;
const WEEKLY_SECONDS = 604_800;
const USAGE_PROBE_TIMEOUT_MS = 30_000;
const CREDITS_PROBE_TIMEOUT_MS = 15_000;

const inputSchema = z.object({ account: z.string().min(1) }).strict();

export interface UsageOptions {
  home?: string;
}

export function resolveAntigravityStoreDir(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  fallbackHome: string,
): string {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if ((arg === "--app-data-dir" || arg === "--app_data_dir") && args[i + 1]) {
      return path.resolve(args[i + 1]!);
    }
    if (arg.startsWith("--app-data-dir=") || arg.startsWith("--app_data_dir=")) {
      return path.resolve(arg.slice(arg.indexOf("=") + 1));
    }
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if ((arg === "--gemini-dir" || arg === "--gemini_dir") && args[i + 1]) {
      return path.resolve(args[i + 1]!, "antigravity-cli");
    }
    if (arg.startsWith("--gemini-dir=") || arg.startsWith("--gemini_dir=")) {
      return path.resolve(arg.slice(arg.indexOf("=") + 1), "antigravity-cli");
    }
  }
  return path.resolve(env.HOME || env.USERPROFILE || fallbackHome, ".gemini", "antigravity-cli");
}

export class Usage {
  private readonly launches = new Map<string, ProviderLaunch>();
  private readonly tiers = new Map<string, string>();
  private readonly defaultHome: string;

  constructor(options: UsageOptions = {}) {
    this.defaultHome = options.home ?? homedir();
  }

  accountKey(args: readonly string[], env: Readonly<Record<string, string | undefined>>): string {
    return hashAccountKey(resolveAntigravityStoreDir(args, env, this.defaultHome));
  }

  remember(launch: ProviderLaunch, tierLabel?: string | null): { account: string } {
    const account = this.accountKey(launch.args, launch.env);
    this.launches.set(account, launch);
    const trimmedTier = tierLabel?.trim();
    if (trimmedTier) this.tiers.set(account, trimmedTier);
    return { account };
  }

  recordTier(launch: ProviderLaunch, tierLabel: string | null | undefined): void {
    const trimmedTier = tierLabel?.trim();
    if (trimmedTier) this.tiers.set(this.accountKey(launch.args, launch.env), trimmedTier);
  }

  registration(): UsageSourceRegistration {
    return {
      id: "antigravity",
      label: "Antigravity",
      icon: "icon.svg",
      input: inputSchema,
      discover: async (scope) => {
        if (scope.kind === "session") {
          if (scope.provider !== "antigravity") return [];
          const exactAccount = this.accountKey(scope.args ?? [], scope.env);
          if (this.launches.has(exactAccount)) {
            return [{ key: exactAccount, label: "Antigravity", input: { account: exactAccount } }];
          }
          if (!scope.args) {
            for (const [key, launch] of this.launches) {
              if (this.accountKey(launch.args, scope.env) === key) {
                return [{ key, label: "Antigravity", input: { account: key } }];
              }
            }
          }
          return [];
        }
        return [...this.launches.keys()].map((account) => ({
          key: account,
          label: "Antigravity",
          input: { account },
        }));
      },
      fetch: async (rawInput) => {
        const { account } = inputSchema.parse(rawInput);
        const launch = this.launches.get(account);
        if (!launch) throw new Error("Antigravity login store no longer exists");
        return this.fetchAccountUsage(account, launch);
      },
    };
  }

  private async fetchAccountUsage(account: string, launch: ProviderLaunch): Promise<UsageReport> {
    const [usageResult, creditsResult] = await Promise.allSettled([
      probe({
        launch,
        args: ["--print-timeout", "24h", "--print", "/usage"],
        timeoutMs: USAGE_PROBE_TIMEOUT_MS,
      }),
      probe({
        launch,
        args: ["--print-timeout", "24h", "--print", "/credits"],
        timeoutMs: CREDITS_PROBE_TIMEOUT_MS,
      }),
    ]);

    if (usageResult.status === "rejected") {
      const reason = usageResult.reason;
      if (reason instanceof AntigravityError && reason.code === "AUTH_REQUIRED") {
        return unavailable({ kind: "rejected", status: 401, refreshedBy: "agy" });
      }
      return {
        status: "error",
        error: reason instanceof Error ? reason.message : String(reason),
      };
    }

    const windows = parseAntigravityUsageWindows(usageResult.value);
    const balances =
      creditsResult.status === "fulfilled" ? parseAntigravityCredits(creditsResult.value) : [];
    if (windows.length === 0 && balances.length === 0) {
      return unavailable({ kind: "no_quota", detail: "No Antigravity usage quota reported" });
    }

    const planLabel = this.tiers.get(account);
    return { status: "available", ...(planLabel ? { planLabel } : {}), windows, balances };
  }
}

export function parseAntigravityUsageWindows(output: string): UsageWindow[] {
  const rows: Array<{ window: UsageWindow; sortRank: number }> = [];
  const takenIds = new Set<string>();
  let currentGroup = "";

  for (const rawLine of output.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (!line || /^quota:?$/i.test(line)) continue;

    let group = currentGroup;
    let limitLabel = "";
    let remainingPct: number | null = null;
    let resetsAt: string | null = null;

    const tableMatch = /^(.*?)\s{2,}(.*?)\s+(\d+)%(?:\s+(.*))?$/i.exec(line);
    if (tableMatch) {
      group = tableMatch[1]!.trim();
      limitLabel = tableMatch[2]!.trim();
      remainingPct = Number.parseInt(tableMatch[3]!, 10);
      resetsAt = parseResetTimestamp(tableMatch[4]);
    } else {
      const parts = line.split(/\t+|\s{2,}/).map((part) => part.trim());
      if (parts.length >= 3) {
        group = parts[0]!;
        limitLabel = parts[1]!;
        const pctMatch = /(\d+)%/.exec(parts[2]!);
        if (pctMatch) remainingPct = Number.parseInt(pctMatch[1]!, 10);
        resetsAt = parseResetTimestamp(parts[3]);
      } else if (line.endsWith(":") && !line.includes("%")) {
        currentGroup = line.slice(0, -1).trim();
        continue;
      }
    }

    if (remainingPct === null || !Number.isFinite(remainingPct)) continue;

    const usedPct = Math.max(0, Math.min(100, 100 - Math.max(0, Math.min(100, remainingPct))));
    const scopeInfo = classifyQuotaScope(group, limitLabel);
    const durationSeconds = classifyDurationSeconds(limitLabel);
    const cleanLimit = limitLabel.replace(/\s+Remaining$/i, "");

    const built = windowFromReportedDuration({
      durationSeconds,
      scope: { id: scopeInfo.id, label: scopeInfo.label },
      unknown: {
        id: normalizeIdentifier(cleanLimit) || "limit",
        label: cleanLimit || "Limit",
        shortLabel: "",
      },
      utilizationPct: usedPct,
      resetsAt,
      summary: scopeInfo.isPrimaryGemini,
      tone: toneFromUsedPct(usedPct),
    });

    const uniqueId = deduplicateId(built.id, takenIds);
    takenIds.add(uniqueId);
    rows.push({
      window: uniqueId === built.id ? built : { ...built, id: uniqueId },
      sortRank: scopeInfo.rankBase + durationSortOffset(durationSeconds),
    });
  }

  rows.sort((a, b) => a.sortRank - b.sortRank);
  const windows = rows.map((entry) => entry.window);
  if (windows.length > 0 && !windows.some((window) => window.summary)) {
    windows[0] = { ...windows[0]!, summary: true };
  }
  return windows;
}

export function parseAntigravityCredits(output: string): UsageBalance[] {
  const match = /Remaining\s+credits\s+([\d.]+)/i.exec(output);
  const remaining = match ? Number.parseFloat(match[1]!) : Number.NaN;
  if (!Number.isFinite(remaining)) return [];
  return [
    {
      id: "credits",
      label: "Model credits",
      remaining,
      unit: "credits",
      tone: remaining > 0 ? "ok" : "default",
    },
  ];
}

export function parseResetTimestamp(
  rawReset: string | undefined | null,
  now = Date.now(),
): string | null {
  const trimmed = rawReset?.trim();
  if (!trimmed) return null;

  const offsetMatch =
    /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}(?::\d{2})?)\s+(UTC|Z|[+-]\d{2}(?::?\d{2})?)$/i.exec(
      trimmed,
    );
  if (offsetMatch) {
    const timePart = offsetMatch[2]!.length === 5 ? `${offsetMatch[2]}:00` : offsetMatch[2]!;
    const rawTz = offsetMatch[3]!.toUpperCase();
    let tz = rawTz;
    if (rawTz === "UTC" || rawTz === "Z") tz = "Z";
    else if (/^[+-]\d{2}$/.test(rawTz)) tz = `${rawTz}:00`;
    else if (/^[+-]\d{4}$/.test(rawTz)) tz = `${rawTz.slice(0, 3)}:${rawTz.slice(3)}`;
    const parsedMs = Date.parse(`${offsetMatch[1]}T${timePart}${tz}`);
    if (!Number.isNaN(parsedMs)) return new Date(parsedMs).toISOString();
  }

  const directMs = Date.parse(trimmed);
  if (!Number.isNaN(directMs)) return new Date(directMs).toISOString();

  const relativeMatch = /^(?:(\d+)\s*d)?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?$/i.exec(trimmed);
  if (relativeMatch && (relativeMatch[1] || relativeMatch[2] || relativeMatch[3])) {
    const days = Number.parseInt(relativeMatch[1] ?? "0", 10);
    const hours = Number.parseInt(relativeMatch[2] ?? "0", 10);
    const minutes = Number.parseInt(relativeMatch[3] ?? "0", 10);
    return new Date(now + ((days * 24 + hours) * 60 + minutes) * 60_000).toISOString();
  }
  return null;
}

function classifyQuotaScope(group: string, limitLabel: string) {
  if (/argon/i.test(`${group} ${limitLabel}`)) {
    return {
      id: "gemini_4_argon",
      label: "Gemini 4 Argon",
      isPrimaryGemini: false,
      rankBase: 20,
    };
  }
  if (/claude|gpt/i.test(group)) {
    return { id: "claude_gpt", label: "Claude & GPT", isPrimaryGemini: false, rankBase: 30 };
  }
  if (/^gemini(?:\s+models)?$/i.test(group.trim()) || !group.trim()) {
    return { id: "gemini", label: "Gemini", isPrimaryGemini: true, rankBase: 10 };
  }
  const cleanGroup = group.replace(/\s+models$/i, "").trim();
  return {
    id: normalizeIdentifier(cleanGroup) || "other",
    label: cleanGroup,
    isPrimaryGemini: false,
    rankBase: 40,
  };
}

function classifyDurationSeconds(limitLabel: string): number | null {
  if (/five\s*hour|5[\s-]*hour|\b5h\b|session/i.test(limitLabel)) return FIVE_HOURS_SECONDS;
  if (/week|7[\s-]*day/i.test(limitLabel)) return WEEKLY_SECONDS;
  return null;
}

function durationSortOffset(durationSeconds: number | null): number {
  if (durationSeconds === FIVE_HOURS_SECONDS) return 0;
  return durationSeconds === WEEKLY_SECONDS ? 1 : 2;
}

function normalizeIdentifier(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function deduplicateId(candidate: string, taken: Set<string>): string {
  if (!taken.has(candidate)) return candidate;
  for (let suffix = 2; ; suffix += 1) {
    const next = `${candidate}_${suffix}`;
    if (!taken.has(next)) return next;
  }
}

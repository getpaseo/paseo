import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { execCommand } from "@getpaseo/plugin/server";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";
import {
  hashAccountKey,
  toneFromUsedPct,
  unavailable,
  windowFromUsedPct,
  type UsageSourceRegistration,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";
import { z } from "zod";

export const inputSchema = z.object({ account: z.string() }).strict();
export type AntigravityUsageInput = z.infer<typeof inputSchema>;

export const agyBucketSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  window: z.string().optional(),
  remaining_fraction: z.number().nullish(),
  remainingFraction: z.number().nullish(),
  reset_time: z.string().nullish(),
  resetTime: z.string().nullish(),
  disabled: z.boolean().nullish(),
  description: z.string().optional(),
});

export const agyGroupSchema = z.object({
  name: z.string().optional(),
  displayName: z.string().optional(),
  description: z.string().optional(),
  buckets: z.array(agyBucketSchema).optional(),
});

export const agyUsageResponseSchema = z.object({
  status: z.string().optional(),
  response: z.string().optional(),
  command: z
    .object({
      name: z.string().optional(),
      data: z
        .object({
          description: z.string().optional(),
          groups: z.array(agyGroupSchema).optional(),
        })
        .optional(),
    })
    .optional(),
});

export function accountKey(env: ProviderLaunch["env"]): string {
  const home = env.HOME ?? homedir();
  const configHome = env.ANTIGRAVITY_HOME ?? path.join(home, ".gemini", "antigravity-cli");
  return hashAccountKey(path.resolve(configHome));
}

function getGroupInfo(name?: string): { prefix: string; short: string; id: string } {
  const groupName = name ?? "";
  if (/argon/i.test(groupName)) {
    return {
      prefix: "Gemini 4 Argon",
      short: "Argon",
      id: "gemini-argon",
    };
  }
  if (/gemini/i.test(groupName)) {
    return {
      prefix: "Gemini",
      short: "Gemini",
      id: "gemini",
    };
  }
  return {
    prefix: "Claude & GPT-OSS",
    short: "Claude/OSS",
    id: "claude-gpt-oss",
  };
}

function bucketWindowShape(
  prefix: string,
  short: string,
  idPrefix: string,
  bucket: z.infer<typeof agyBucketSchema>,
): { id: string; label: string; shortLabel: string; isWeekly: boolean } {
  const isWeekly =
    /week/i.test(bucket.window ?? "") ||
    /week/i.test(bucket.id ?? "") ||
    /week/i.test(bucket.name ?? "");
  const isWeeklyLabel = isWeekly ? "Weekly" : "5h";
  const shortLabel = `${short} ${isWeekly ? "wk" : "5h"}`;
  return {
    id: isWeekly ? `${idPrefix}-weekly` : `${idPrefix}-5h`,
    label: `${prefix} \u00b7 ${isWeeklyLabel}`,
    shortLabel,
    isWeekly,
  };
}

export function buildSummaryWindows(groups: z.infer<typeof agyGroupSchema>[]): UsageWindow[] {
  const windows: UsageWindow[] = [];

  for (const group of groups) {
    const groupName = group.displayName ?? group.name ?? "";
    const { prefix: groupPrefix, short: groupShort, id: idPrefix } = getGroupInfo(groupName);

    for (const bucket of group.buckets ?? []) {
      const shape = bucketWindowShape(groupPrefix, groupShort, idPrefix, bucket);

      // A limit agy marks disabled (e.g. the Claude/GPT 5h window on free plans) does not apply.
      // It must not read as unused quota, so the percentages stay null and the label carries the
      // state; the app renders a null-percentage window as "—".
      if (bucket.disabled === true) {
        windows.push(
          windowFromUsedPct({
            id: shape.id,
            label: `${shape.label} \u00b7 Disabled`,
            shortLabel: shape.shortLabel,
            utilizationPct: null,
            resetsAt: null,
            tone: "default",
          }),
        );
        continue;
      }

      const remainingFraction = bucket.remaining_fraction ?? bucket.remainingFraction;
      if (remainingFraction == null) continue;

      const utilizationPct = Math.max(0, Math.min(100, Math.round((1 - remainingFraction) * 100)));

      windows.push(
        windowFromUsedPct({
          id: shape.id,
          label: shape.label,
          shortLabel: shape.shortLabel,
          summary: shape.isWeekly,
          utilizationPct,
          resetsAt: bucket.reset_time ?? bucket.resetTime ?? null,
          tone: toneFromUsedPct(utilizationPct),
        }),
      );
    }
  }

  return windows;
}

export type UsageRunner = (launch: ProviderLaunch, args: string[]) => Promise<string>;

export async function defaultUsageRunner(launch: ProviderLaunch, args: string[]): Promise<string> {
  const safeArgs = launch.args.filter(
    (arg) =>
      arg !== "--disable-slash-commands" &&
      arg !== "-p" &&
      arg !== "--print" &&
      arg !== "--prompt" &&
      !arg.startsWith("--input-format") &&
      !arg.startsWith("--output-format"),
  );
  const result = await execCommand(
    launch.command,
    [...safeArgs, "-p", "/usage", "--output-format", "json", ...args],
    {
      env: launch.env,
      timeout: 15_000,
    },
  );
  return result.stdout;
}

export class Usage {
  private readonly launches = new Map<string, ProviderLaunch>();
  private readonly runner: UsageRunner;
  private readonly getEnvironment: () => NodeJS.ProcessEnv;
  private fallbackKey: string | null = null;

  constructor(
    runner: UsageRunner = defaultUsageRunner,
    getEnvironment: () => NodeJS.ProcessEnv = () => process.env,
  ) {
    this.runner = runner;
    this.getEnvironment = getEnvironment;
  }

  private environment(): Record<string, string> {
    const record: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.getEnvironment()))
      if (typeof value === "string") record[key] = value;
    return record;
  }

  remember(launch: ProviderLaunch): { account: string } {
    const key = accountKey(launch.env);
    this.launches.set(key, launch);
    // The daemon-resolved launch supersedes the placeholder. When the provider overrides keep
    // the same account key the placeholder entry itself was replaced; otherwise the provider
    // overrides changed the account key and the placeholder must not survive as a phantom
    // card. Either way the launch remembered for that key is real and must never be deleted.
    if (this.fallbackKey !== null) {
      if (this.fallbackKey !== key) this.launches.delete(this.fallbackKey);
      this.fallbackKey = null;
    }
    return { account: key };
  }

  /**
   * Global discovery runs before any provider snapshot on a fresh daemon, and the Antigravity
   * card would stay hidden until the first status()/connect(). The CLI's config directory is
   * the one launch-free signal that a login exists here, so a placeholder launch standing in
   * for the daemon-resolved one keeps the card visible from the first `paseo usage`.
   */
  private rememberFallbackLaunch(): void {
    const env = this.environment();
    const home = env.HOME ?? homedir();
    const configHome = env.ANTIGRAVITY_HOME ?? path.join(home, ".gemini", "antigravity-cli");
    if (!existsSync(configHome)) return;
    const account = accountKey(env);
    this.launches.set(account, { command: "agy", args: [], env });
    this.fallbackKey = account;
  }

  registration(): UsageSourceRegistration {
    return {
      id: "antigravity",
      label: "Antigravity",
      icon: "icon.svg",
      input: inputSchema,
      discover: async (scope) => {
        let accounts: string[];
        if (scope.kind === "global") {
          if (this.launches.size === 0) this.rememberFallbackLaunch();
          accounts = [...this.launches.keys()];
        } else {
          if (scope.provider !== "antigravity") return [];
          const account = accountKey(scope.env);
          if (!this.launches.has(account) && this.launches.size > 0) {
            const baseLaunch = this.launches.values().next().value;
            if (baseLaunch) {
              this.launches.set(account, { ...baseLaunch, env: scope.env });
            }
          }
          accounts = this.launches.has(account) ? [account] : [];
        }
        return accounts.map((account) => ({
          key: account,
          label: "Antigravity",
          input: { account },
        }));
      },
      fetch: async (input) => {
        const { account } = inputSchema.parse(input);
        const launch = this.launches.get(account);
        if (!launch) throw new Error("Antigravity login no longer exists");

        try {
          const stdout = await this.runner(launch, []);
          const text = stdout.trim();
          if (!text) {
            return { status: "error", error: "Empty output from agy usage" };
          }

          let json: unknown;
          try {
            json = JSON.parse(text);
          } catch {
            return {
              status: "error",
              error: `Failed to parse agy output: ${text.slice(0, 100)}`,
            };
          }

          const parsed = agyUsageResponseSchema.safeParse(json);
          if (!parsed.success) {
            return { status: "error", error: "Unexpected response format from agy usage" };
          }

          if (parsed.data.status !== "SUCCESS") {
            const responseMsg =
              parsed.data.response || `agy reported status: ${parsed.data.status ?? "UNKNOWN"}`;
            if (/not authenticated|unauthenticated|sign in/i.test(responseMsg)) {
              return unavailable({
                kind: "rejected",
                status: 401,
                refreshedBy: "agy",
              });
            }
            return {
              status: "error",
              error: responseMsg,
            };
          }

          const groups = parsed.data.command?.data?.groups ?? [];
          const windows = buildSummaryWindows(groups);
          if (windows.length === 0) {
            return unavailable({
              kind: "no_quota",
              detail: "No usage quota reported by agy",
            });
          }

          return {
            status: "available",
            windows,
            details: [
              {
                id: "observed",
                label: "Observed",
                value: new Date().toISOString(),
              },
            ],
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/not authenticated|unauthenticated|sign in/i.test(message)) {
            return unavailable({
              kind: "rejected",
              status: 401,
              refreshedBy: "agy",
            });
          }
          return {
            status: "error",
            error: message,
          };
        }
      },
    };
  }
}

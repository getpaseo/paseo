import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { execCommand } from "@getpaseo/plugin/server";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";
import {
  hashAccountKey,
  toneFromUsedPct,
  unavailable,
  windowFromUsedPct,
  type UsageSourceRegistration,
} from "@getpaseo/plugin/server/usage";

const input = z.object({ launch: z.string() }).strict();
const response = z.object({
  status: z.string(),
  error: z.string().optional(),
  response: z.string().optional(),
  command: z
    .object({
      name: z.literal("usage"),
      data: z.object({
        groups: z.array(
          z.object({
            name: z.string(),
            buckets: z.array(
              z.object({
                id: z.string().min(1),
                name: z.string(),
                window: z.string(),
                remaining_fraction: z.number().min(0).max(1).nullish(),
                reset_time: z.string().nullish(),
                disabled: z.boolean().optional(),
              }),
            ),
          }),
        ),
      }),
    })
    .optional(),
});

function accountKey(env: ProviderLaunch["env"]): string {
  return hashAccountKey(
    path.resolve(
      env.ANTIGRAVITY_HOME ?? path.join(env.HOME ?? homedir(), ".gemini", "antigravity-cli"),
    ),
  );
}

function shortWindow(window: string): string {
  const trimmed = window.trim();
  const normalized = trimmed.toLowerCase();
  if (normalized === "weekly") return "wk";
  if (normalized === "monthly") return "mo";
  return trimmed;
}

function shortGroupName(name: string): string {
  return name
    .trim()
    .replace(/\s+models$/i, "")
    .trim();
}

function formatShortLabel(groupName: string, window: string, includeGroup: boolean): string {
  const period = shortWindow(window);
  if (!includeGroup) return period;
  const scope = shortGroupName(groupName);
  return scope ? `${scope} ${period}` : period;
}

export class Usage {
  private readonly launches = new Map<string, ProviderLaunch>();

  registration(): UsageSourceRegistration {
    return {
      id: "antigravity",
      label: "Antigravity",
      icon: "icon.svg",
      input,
      provider: "antigravity",
      discover: async (scope) => {
        if (scope.kind === "session" && scope.provider !== "antigravity") return [];
        if (!scope.launch) return [];
        const launch = scope.launch;
        const key = accountKey(launch.env);
        const locator = hashAccountKey(JSON.stringify(launch));
        this.launches.set(locator, launch);
        return [{ key, input: { launch: locator } }];
      },
      fetch: async (value) => {
        const { launch: locator } = input.parse(value);
        const launch = this.launches.get(locator);
        if (!launch) throw new Error("Antigravity launch no longer exists");
        const acpIndex = launch.args.indexOf("acp");
        if (acpIndex < 0) throw new Error("Antigravity launch does not contain the acp subcommand");
        let result;
        try {
          result = await execCommand(
            launch.command,
            [...launch.args.slice(0, acpIndex), "-p", "/usage", "--output-format", "json"],
            {
              env: launch.env,
              timeout: 18_000,
              maxBuffer: 1024 * 1024,
            },
          );
        } catch {
          throw new Error(
            "Antigravity usage command failed or timed out. Check that agy is signed in.",
          );
        }
        const data = response.parse(JSON.parse(result.stdout));
        if (data.status !== "SUCCESS") {
          throw new Error(data.error || data.response || `agy usage returned ${data.status}`);
        }
        if (!data.command) throw new Error("agy did not return usage data");
        const groups = data.command.data.groups;
        const includeGroup = groups.length > 1;
        const windows = groups.flatMap((group) =>
          group.buckets.flatMap((bucket) => {
            if (!bucket.disabled && bucket.remaining_fraction == null) return [];
            const used = bucket.disabled ? null : (1 - bucket.remaining_fraction!) * 100;
            return [
              windowFromUsedPct({
                id: bucket.id,
                label: `${group.name} · ${bucket.name}${bucket.disabled ? " · Disabled" : ""}`,
                shortLabel: formatShortLabel(group.name, bucket.window, includeGroup),
                summary: !bucket.disabled && bucket.window === "weekly",
                utilizationPct: used,
                resetsAt: bucket.disabled ? null : bucket.reset_time,
                tone: used === null ? "default" : toneFromUsedPct(used),
              }),
            ];
          }),
        );
        if (windows.length === 0)
          return unavailable({ kind: "no_quota", detail: "No usage quota reported by agy" });
        return { status: "available", windows };
      },
    };
  }
}

import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { UsageSourceRegistration } from "@getpaseo/plugin/server";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";
import {
  hashAccountKey,
  unavailableUsage,
  windowFromUsedPct,
  toneFromUsedPct,
} from "@getpaseo/plugin/server/usage";

import { MspConnection } from "./connection.js";
import { usageSchema } from "./wire.js";

const inputSchema = z.object({ account: z.string() }).strict();
type Observation = z.infer<typeof usageSchema>;
export class Usage {
  private readonly launches = new Map<string, ProviderLaunch>();
  private readonly sessions = new Map<
    string,
    { account: string; read: () => Promise<Observation> }
  >();
  remember(launch: ProviderLaunch): { account: string } {
    // MSP 1.4.1 has no stable account ID; swapping accounts in one config directory shares a report ID.
    const configHome =
      launch.env.XDG_CONFIG_HOME ?? path.join(launch.env.HOME ?? homedir(), ".config");
    const key = hashAccountKey(path.resolve(configHome, "muse"));
    this.launches.set(key, launch);
    return { account: key };
  }
  attach(id: string, launch: ProviderLaunch, read: () => Promise<Observation>): void {
    this.sessions.set(id, { ...this.remember(launch), read });
  }
  detach(id: string): void {
    this.sessions.delete(id);
  }
  private async read(account: string, launch: ProviderLaunch): Promise<Observation> {
    const readers = [...this.sessions.values()].filter((session) => session.account === account);
    if (readers.length > 0) {
      const observations = await Promise.all(readers.map((session) => session.read()));
      const usages = observations.flatMap((observation) =>
        observation.usage ? [observation.usage] : [],
      );
      usages.sort((a, b) => b.observedAtMs - a.observedAtMs);
      return usages.length > 0 ? { usage: usages[0] } : {};
    }
    const host = new MspConnection({ launch });
    try {
      await host.initialize();
      return await host.request("usage/read", {}, usageSchema);
    } finally {
      await host.close();
    }
  }
  registration(): UsageSourceRegistration {
    return {
      id: "muse",
      label: "Muse Code",
      icon: "icon.svg",
      input: inputSchema,
      discover: async () => [...this.launches.keys()].map((account) => ({ account })),
      identify: async (input) => {
        const { account } = inputSchema.parse(input);
        return this.launches.has(account) ? { key: account, label: "Muse Code" } : null;
      },
      fetch: async (input) => {
        const { account } = inputSchema.parse(input);
        const launch = this.launches.get(account);
        if (!launch) return unavailableUsage();
        try {
          const { usage } = await this.read(account, launch);
          if (!usage) return unavailableUsage();
          return {
            status: "available",
            planLabel: usage.tier,
            windows: [
              windowFromUsedPct({
                id: "five_hour",
                label: `${usage.window.windowDurationMins / 60} hours`,
                shortLabel: `${usage.window.windowDurationMins / 60}h`,
                summary: true,
                utilizationPct: usage.window.usedPercent,
                resetsAt: new Date(usage.window.resetsAtMs).toISOString(),
                tone: toneFromUsedPct(usage.window.usedPercent),
              }),
              windowFromUsedPct({
                id: "weekly",
                label: "Weekly",
                shortLabel: "wk",
                summary: true,
                utilizationPct: usage.weekly.usedPercent,
                resetsAt: new Date(usage.weekly.resetsAtMs).toISOString(),
                tone: toneFromUsedPct(usage.weekly.usedPercent),
              }),
            ],
            details: [
              {
                id: "observed",
                label: "Observed",
                value: new Date(usage.observedAtMs).toISOString(),
              },
            ],
          };
        } catch (error) {
          return {
            status: "error",
            windows: [],
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
    };
  }
}

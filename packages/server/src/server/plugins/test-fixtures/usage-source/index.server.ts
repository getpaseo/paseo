import type { PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { windowFromReportedDuration } from "@getpaseo/plugin/server/usage";

let fetches = 0;
export default function contribute(server: PluginServerContext) {
  server.registerUsageSource({
    id: "fixture",
    label: "Fixture",
    icon: "icon.svg",
    input: z.object({ account: z.string() }).strict(),
    discover: async () => {
      const inputs: Array<Record<string, string | boolean>> = [
        { account: "one" },
        { account: "bad", extra: true },
        { account: "throws" },
        { account: "expired" },
      ];
      return inputs.map((input) => ({ key: String(input.account), input }));
    },
    fetch: async (input) => {
      const account = (input as { account: string }).account;
      if (account === "expired")
        return {
          status: "unavailable",
          problem: {
            kind: "expired",
            expiresAt: new Date(Date.now() - 3_600_000).toISOString(),
            refreshedBy: "claude",
          },
        };
      if (account === "throws") throw new Error("fixture failure");
      fetches++;
      return {
        status: "available",
        windows: [
          windowFromReportedDuration({
            durationSeconds: 604800,
            unknown: { id: "unknown", label: "Limit", shortLabel: "" },
            utilizationPct: fetches,
          }),
        ],
      };
    },
  });
  return () => {};
}

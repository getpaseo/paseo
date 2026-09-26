import type { PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";

let fetches = 0;
export default function contribute(server: PluginServerContext) {
  server.registerUsageSource({
    id: "fixture-directory",
    label: "Fixture",
    icon: "icon.svg",
    input: z.object({ account: z.string() }).strict(),
    discover: async () => {
      const inputs: Array<Record<string, string | boolean>> = [
        { account: "one" },
        { account: "bad", extra: true },
        { account: "throws" },
      ];
      return inputs;
    },
    fetch: async (input) => {
      const account = (input as { account: string }).account;
      if (account === "throws") throw new Error("fixture failure");
      fetches++;
      return {
        account: { key: account },
        status: "available",
        windows: [{ id: "count", label: "Count", usedPct: fetches, headline: true }],
      };
    },
  });
  return () => {};
}

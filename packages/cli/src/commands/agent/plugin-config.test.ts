import { expect, test } from "vitest";
import { runPluginConfig } from "./plugin-config.js";

const agentId = "11111111-1111-4111-8111-111111111111";

test("plugin adoption refuses prefixes and implicit mutation before connecting", async () => {
  const connect = async (): Promise<never> => {
    throw new Error("unexpected connection");
  };
  await expect(runPluginConfig("preview", "1111", { plugin: "notes" }, connect)).rejects.toThrow(
    "exact agent UUID",
  );
  await expect(
    runPluginConfig("apply", agentId, { plugin: "notes", select: ["endpoint"] }, connect),
  ).rejects.toThrow("--expect");
  await expect(
    runPluginConfig(
      "apply",
      agentId,
      { plugin: "notes", yes: true, expect: "fingerprint" },
      connect,
    ),
  ).rejects.toThrow("Select candidates explicitly");
});

test("plugin adoption forwards explicit baselines without resolving or loading an agent", async () => {
  const calls: unknown[] = [];
  let closed = false;
  const result = await runPluginConfig(
    "apply",
    agentId,
    {
      plugin: "notes",
      expect: "fingerprint",
      yes: true,
      select: ["timeout=inherit", "endpoint"],
    },
    async () => ({
      previewLegacyPluginConfig: async () => {
        throw new Error("unexpected preview");
      },
      resetLegacyPluginConfig: async () => {
        throw new Error("unexpected reset");
      },
      applyLegacyPluginConfig: async (id, input) => {
        calls.push({ id, input });
        return { receiptIds: ["receipt"], appliesOn: "next-open" as const };
      },
      close: async () => {
        closed = true;
      },
    }),
  );
  expect(calls).toEqual([
    {
      id: agentId,
      input: {
        pluginId: "notes",
        expectedFingerprint: "fingerprint",
        selections: [{ id: "timeout", baselineId: "inherit" }, { id: "endpoint" }],
      },
    },
  ]);
  expect(result.data.details).toBe('{"receiptIds":["receipt"],"appliesOn":"next-open"}');
  expect(closed).toBe(true);
});

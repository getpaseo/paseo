import { describe, expect, it } from "vitest";
import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { createDeviceSettings } from "./device";

function device(records = new Map<string, string>()) {
  return createDeviceSettings({
    getItem: async (key) => records.get(key) ?? null,
    setItem: async (key, value) => {
      records.set(key, value);
    },
  });
}
const definition = defineSettings({
  id: "layout",
  scope: "device",
  version: 1,
  schema: z.object({ collapsed: z.array(z.string()).default([]) }),
});

describe("device plugin settings", () => {
  it("shares one installation across hosts and keeps other installations separate", async () => {
    const settings = device();
    const first = settings("plugin", definition);
    const second = settings("plugin", definition);
    const before = await first.read();
    expect(before).toEqual({ status: "ready", revision: "missing", values: { collapsed: [] } });
    const saved = await first.write({ revision: before.revision, values: { collapsed: ["work"] } });
    expect(saved.status).toBe("saved");
    expect(await second.read()).toMatchObject({ status: "ready", values: { collapsed: ["work"] } });
    expect(await settings("other", definition).read()).toEqual(before);
  });
  it("serializes competing writes and resets through the same revision contract", async () => {
    const settings = device()("plugin", definition);
    const initial = await settings.read();
    const results = await Promise.all([
      settings.write({ revision: initial.revision, values: { collapsed: ["a"] } }),
      settings.write({ revision: initial.revision, values: { collapsed: ["b"] } }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["saved", "conflict"]);
    const current = await settings.read();
    expect(await settings.reset({ revision: current.revision })).toMatchObject({
      status: "saved",
      values: { collapsed: [] },
    });
  });
  it("validates writes and migrates saved layout values", async () => {
    const settings = device();
    const first = settings("plugin", definition);
    expect(await first.write({ revision: "missing", values: { collapsed: 3 } })).toMatchObject({
      status: "invalid",
    });
    await first.write({ revision: "missing", values: { collapsed: ["a"] } });
    const upgraded = settings(
      "plugin",
      defineSettings({
        ...definition,
        version: 2,
        migrate: (_values, from) => ({ collapsed: [`v${from}`] }),
      }),
    );
    expect(await upgraded.read()).toMatchObject({ status: "ready", values: { collapsed: ["v1"] } });
  });
});

it("persists a validated migration once and returns the persisted revision across restarts", async () => {
  const records = new Map<string, string>();
  const settings = device(records);
  await settings("plugin", definition).write({ revision: "missing", values: { collapsed: ["a"] } });
  let migrations = 0;
  const upgraded = defineSettings({
    ...definition,
    version: 2,
    migrate: () => {
      migrations++;
      return { collapsed: ["migrated"] };
    },
  });
  const first = await settings("plugin", upgraded).read();
  const restarted = device(records)("plugin", upgraded);
  expect(await restarted.read()).toEqual(first);
  expect(migrations).toBe(1);
  expect(first).toEqual({
    status: "ready",
    revision: JSON.stringify({ version: 2, values: { collapsed: ["migrated"] } }),
    values: { collapsed: ["migrated"] },
  });
  expect(
    await restarted.write({
      revision: JSON.stringify({ version: 1, values: { collapsed: ["a"] } }),
      values: { collapsed: [] },
    }),
  ).toMatchObject({ status: "conflict" });
  expect(
    await restarted.write({ revision: first.revision, values: { collapsed: [] } }),
  ).toMatchObject({ status: "saved" });
});

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { PluginSettingsStore } from "./index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const definition = defineSettings({
  id: "display",
  scope: "host",
  version: 1,
  schema: z.object({
    enabled: z.boolean().default(true),
    count: z.number().int().min(1).default(5),
  }),
});
async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), "plugin-settings-"));
  roots.push(directory);
  const changes: string[] = [];
  const store = new PluginSettingsStore(directory, (id) => changes.push(id));
  return { directory, changes, handlers: store.register(definition) };
}

test("defaults, atomic saves, concurrent revisions, and restart persistence", async () => {
  const { directory, changes, handlers } = await setup();
  expect(await handlers.read.handle()).toEqual({
    status: "ready",
    revision: "missing",
    values: { enabled: true, count: 5 },
  });
  const outcomes = await Promise.all([
    handlers.write.handle({ revision: "missing", values: { enabled: false, count: 10 } }),
    handlers.write.handle({ revision: "missing", values: { enabled: true, count: 20 } }),
  ]);
  expect(outcomes.map((result) => result.status)).toEqual(["saved", "conflict"]);
  const reopened = new PluginSettingsStore(directory, () => {}).register(definition);
  expect(await reopened.read.handle()).toMatchObject({
    status: "ready",
    values: { enabled: false, count: 10 },
  });
  expect(changes).toEqual(["display"]);
});

test("validation failure preserves disk and leaves the writer usable", async () => {
  const { handlers, changes } = await setup();
  expect(await handlers.write.handle({ revision: "missing", values: { count: -1 } })).toMatchObject(
    { status: "invalid" },
  );
  expect(await handlers.read.handle()).toMatchObject({ revision: "missing" });
  expect(changes).toEqual([]);
  expect(await handlers.write.handle({ revision: "missing", values: { count: 2 } })).toMatchObject({
    status: "saved",
    values: { enabled: true, count: 2 },
  });
});

test("migrates once, persists the validated version, and rejects old clients", async () => {
  const { directory, handlers } = await setup();
  const saved = await handlers.write.handle({ revision: "missing", values: { count: 7 } });
  if (saved.status !== "saved") throw new Error("save failed");
  let migrations = 0;
  const upgraded = new PluginSettingsStore(directory, () => {}).register({
    ...definition,
    version: 2,
    schema: z.object({ total: z.number().default(0) }),
    migrate(values, version) {
      migrations++;
      expect(version).toBe(1);
      return { total: z.object({ count: z.number() }).parse(values).count };
    },
  });
  expect(await upgraded.read.handle()).toMatchObject({ status: "ready", values: { total: 7 } });
  await upgraded.read.handle();
  expect(migrations).toBe(1);
  expect(
    await handlers.write.handle({ revision: saved.revision, values: { count: 9 } }),
  ).toMatchObject({ status: "conflict" });
  const newer = await handlers.read.handle();
  expect(newer).toMatchObject({
    status: "invalid",
    error: expect.stringContaining("newer plugin"),
  });
  expect(
    await handlers.write.handle({ revision: newer.revision, values: { count: 9 } }),
  ).toMatchObject({ status: "invalid" });
  expect(await upgraded.read.handle()).toMatchObject({ values: { total: 7 } });
});

test("failed migrations and corrupt data survive reads until an explicit reset", async () => {
  const { directory, handlers } = await setup();
  await handlers.write.handle({ revision: "missing", values: { count: 7 } });
  const file = path.join(directory, "display.json");
  const before = await readFile(file, "utf8");
  const upgraded = new PluginSettingsStore(directory, () => {}).register({
    ...definition,
    version: 2,
    migrate() {
      throw new Error("migration failed");
    },
  });
  expect(await upgraded.read.handle()).toMatchObject({
    status: "invalid",
    error: "migration failed",
  });
  expect(await readFile(file, "utf8")).toBe(before);
  await writeFile(file, "broken JSON");
  const invalid = await handlers.read.handle();
  expect(invalid.status).toBe("invalid");
  expect(await readFile(file, "utf8")).toBe("broken JSON");
  expect(await handlers.reset.handle({ revision: invalid.revision })).toMatchObject({
    status: "saved",
    values: { enabled: true, count: 5 },
  });
});

test("installation namespaces and definition IDs remain separate", async () => {
  const first = await setup();
  const second = await setup();
  await first.handlers.write.handle({ revision: "missing", values: { enabled: false } });
  expect(await second.handlers.read.handle()).toMatchObject({ values: { enabled: true } });
  const store = new PluginSettingsStore(first.directory, () => {});
  store.register(definition);
  expect(() => store.register(definition)).toThrow("Duplicate settings");
  expect(() => store.register({ ...definition, id: "../escape" })).toThrow("Invalid settings ID");
});

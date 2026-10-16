import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { defineSettings } from "@getpaseo/plugin";
import type { PluginSettingsState } from "@getpaseo/plugin/server";
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
type DisplaySettingsState = PluginSettingsState<typeof definition.schema>;
function mutateNotification(state: DisplaySettingsState): void {
  if (state.status === "ready") state.values.count = 99;
}
async function setup(options?: { watchdogMs?: number; onPoisoned?: (message: string) => void }) {
  const directory = await mkdtemp(path.join(tmpdir(), "plugin-settings-"));
  roots.push(directory);
  const changes: string[] = [];
  const store = new PluginSettingsStore(
    directory,
    (id) => changes.push(id),
    options?.watchdogMs,
    options?.onPoisoned,
  );
  return { directory, changes, store, handlers: store.register(definition) };
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

test("server settings read current values and notify after successful writes", async () => {
  const { handlers } = await setup();
  const notifications: unknown[] = [];
  const unsubscribe = handlers.settings.subscribe((state) => {
    notifications.push(state);
    mutateNotification(state);
  });

  expect(await handlers.settings.read()).toEqual({
    status: "ready",
    revision: "missing",
    values: { enabled: true, count: 5 },
  });
  const saved = await handlers.write.handle({
    revision: "missing",
    values: { enabled: false, count: 10 },
  });
  expect(saved).toMatchObject({ status: "saved", values: { enabled: false, count: 10 } });
  const current = await handlers.settings.read();
  expect(current).toMatchObject({
    status: "ready",
    values: { enabled: false, count: 10 },
  });
  expect(notifications).toEqual([
    {
      status: "ready",
      revision: current.revision,
      values: { enabled: false, count: 99 },
    },
  ]);

  expect(
    await handlers.write.handle({ revision: current.revision, values: { count: -1 } }),
  ).toMatchObject({ status: "invalid" });
  expect(notifications).toHaveLength(1);

  unsubscribe();
  await handlers.reset.handle({ revision: current.revision });
  expect(notifications).toHaveLength(1);
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
    code: "stored_invalid",
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
    code: "migration_failed",
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

test("server reads classify invalid storage without echoing stored values", async () => {
  const { directory, handlers } = await setup();
  await writeFile(path.join(directory, "display.json"), '{"secret":"do-not-echo"}');
  expect(await handlers.settings.read()).toEqual({
    status: "invalid",
    revision: expect.any(String),
    code: "stored_invalid",
    error: expect.not.stringContaining("do-not-echo"),
  });
});

test("document updates serialize and unchanged does not write or invalidate", async () => {
  const { changes, handlers } = await setup();
  const observations: number[] = [];
  const first = handlers.settings.update((current) => {
    observations.push(current.count);
    return { status: "commit", values: { ...current, count: 6 }, result: "first" };
  });
  const second = handlers.settings.update((current) => {
    observations.push(current.count);
    return { status: "commit", values: { ...current, count: 7 }, result: "second" };
  });
  expect(await first).toMatchObject({ status: "saved", result: "first" });
  expect(await second).toMatchObject({ status: "saved", result: "second" });
  const unchanged = await handlers.settings.update((current) => ({
    status: "unchanged",
    result: current.count,
  }));
  expect(unchanged).toMatchObject({ status: "unchanged", result: 7 });
  expect(observations).toEqual([5, 6]);
  expect(changes).toEqual(["display", "display"]);
});

test("server updates notify subscribers and clients exactly like a client save", async () => {
  const { changes, handlers } = await setup();
  const notifications: unknown[] = [];
  handlers.settings.subscribe((state) => {
    notifications.push(state);
  });
  const saved = await handlers.settings.update((current) => ({
    status: "commit",
    values: { ...current, count: 6 },
    result: null,
  }));
  expect(saved).toMatchObject({ status: "saved", values: { count: 6 } });
  expect(notifications).toEqual([
    { status: "ready", revision: saved.revision, values: { enabled: true, count: 6 } },
  ]);
  expect(changes).toEqual(["display"]);
  expect(await handlers.read.handle()).toMatchObject({
    revision: saved.revision,
    values: { count: 6 },
  });
});

test("migration and mutation persist once, including migration plus unchanged", async () => {
  const first = await setup();
  await first.handlers.write.handle({ revision: "missing", values: { count: 7 } });
  const changed: string[] = [];
  const upgradedStore = new PluginSettingsStore(first.directory, (id) => changed.push(id));
  const upgraded = upgradedStore.register({
    ...definition,
    version: 2,
    schema: z.object({ enabled: z.boolean().default(true), count: z.number().int() }),
    migrate(values) {
      return values;
    },
  });
  expect(
    await upgraded.settings.update((current) => ({
      status: "commit",
      values: { ...current, count: current.count + 1 },
      result: null,
    })),
  ).toMatchObject({ status: "saved", values: { count: 8 } });
  expect(changed).toEqual(["display"]);

  const thirdVersionChanges: string[] = [];
  const thirdVersion = new PluginSettingsStore(first.directory, (id) =>
    thirdVersionChanges.push(id),
  ).register({
    ...definition,
    version: 3,
    migrate(values) {
      return values;
    },
  });
  expect(
    await thirdVersion.settings.update((current) => ({
      status: "unchanged",
      result: current.count,
    })),
  ).toMatchObject({ status: "saved", result: 8 });
  expect(thirdVersionChanges).toEqual(["display"]);
});

test("client CAS is checked after a queued server migration update", async () => {
  const first = await setup();
  const saved = await first.handlers.write.handle({ revision: "missing", values: { count: 5 } });
  if (saved.status !== "saved") throw new Error("save failed");
  let releaseMigration!: () => void;
  const migrationGate = new Promise<void>((resolve) => {
    releaseMigration = resolve;
  });
  const store = new PluginSettingsStore(first.directory, () => {});
  const upgraded = store.register({
    ...definition,
    version: 2,
    async migrate(values) {
      await migrationGate;
      return values;
    },
  });
  const serverUpdate = upgraded.settings.update((current) => ({
    status: "commit",
    values: { ...current, count: 6 },
    result: null,
  }));
  const clientWrite = upgraded.write.handle({ revision: saved.revision, values: { count: 9 } });
  releaseMigration();
  expect(await serverUpdate).toMatchObject({ status: "saved" });
  expect(await clientWrite).toMatchObject({ status: "conflict" });
  expect(await upgraded.settings.read()).toMatchObject({ values: { count: 6 } });
});

test("mutator input is deeply detached and frozen", async () => {
  const nestedDefinition = defineSettings({
    id: "nested",
    scope: "host",
    version: 1,
    schema: z.object({ nested: z.object({ value: z.number() }).default({ value: 1 }) }),
  });
  const { store } = await setup();
  const nested = store.register(nestedDefinition);
  const result = await nested.settings.update((current) => {
    expect(Object.isFrozen(current)).toBe(true);
    expect(Object.isFrozen(current.nested)).toBe(true);
    (current.nested as { value: number }).value = 9;
    return { status: "unchanged", result: null };
  });
  expect(result).toMatchObject({ status: "invalid", code: "mutator_threw" });
  expect(await nested.settings.read()).toMatchObject({
    values: { nested: { value: 1 } },
  });
});

test("thenables, reentry, throws, and invalid next values do not commit and leave queue usable", async () => {
  const { changes, handlers } = await setup();
  expect(
    await handlers.settings.update((() =>
      Promise.resolve({ status: "unchanged", result: null })) as never),
  ).toMatchObject({ status: "invalid", code: "thenable_returned" });

  let nestedResult: unknown;
  expect(
    await handlers.settings.update((current) => {
      void handlers.settings.read().then((result) => {
        nestedResult = result;
        return null;
      });
      return { status: "commit", values: { ...current, count: 8 }, result: null };
    }),
  ).toMatchObject({ status: "invalid", code: "reentrant_access" });
  await Promise.resolve();
  expect(nestedResult).toMatchObject({ status: "invalid", code: "reentrant_access" });

  expect(
    await handlers.settings.update(() => {
      throw new Error("secret value");
    }),
  ).toMatchObject({ status: "invalid", code: "mutator_threw" });
  expect(
    await handlers.settings.update(() => ({
      status: "commit",
      values: { enabled: true, count: 0 },
      result: null,
    })),
  ).toMatchObject({ status: "invalid", code: "next_invalid" });
  expect(changes).toEqual([]);
  expect(
    await handlers.settings.update((current) => ({
      status: "commit",
      values: { ...current, count: 6 },
      result: null,
    })),
  ).toMatchObject({ status: "saved", values: { count: 6 } });
});

test("watchdog poisons callers without releasing the blocked queue item", async () => {
  const poisoned: string[] = [];
  const { directory } = await setup();
  await writeFile(
    path.join(directory, "display.json"),
    JSON.stringify({ version: 1, values: { count: 5 } }),
  );
  const never = new Promise<never>(() => undefined);
  const store = new PluginSettingsStore(
    directory,
    () => {},
    5,
    (message) => poisoned.push(message),
  );
  const handlers = store.register({
    ...definition,
    version: 2,
    migrate: () => never,
  });
  expect(await handlers.settings.read()).toMatchObject({
    status: "invalid",
    code: "store_poisoned",
  });
  expect(
    await handlers.settings.update(() => ({ status: "unchanged", result: null })),
  ).toMatchObject({ status: "invalid", code: "store_poisoned" });
  expect(poisoned).toEqual(["Settings access is unavailable until the plugin is reloaded."]);
});

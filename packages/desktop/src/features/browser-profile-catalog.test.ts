import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createBrowserProfileCatalog } from "./browser-profile-catalog.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "profile-catalog-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const group = { serverId: "host", projectId: "project" };
const composed = "Caf\u00e9 1";
const decomposed = "Cafe\u0301 1";

async function created(
  promise: ReturnType<ReturnType<typeof createBrowserProfileCatalog>["create"]>,
) {
  const result = await promise;
  if (!result.ok) throw new Error("create failed: " + result.code);
  return result.profile;
}

test("concurrent creates allocate stable bounded keys inside their group", async () => {
  const catalog = createBrowserProfileCatalog(directory);
  const names = [" Café ", "Cafe", "x".repeat(48), "x".repeat(49), "公司"];
  const rows = await Promise.all(names.map((name) => created(catalog.create({ group, name }))));
  expect(rows.map((row) => row.slug)).toEqual([
    "cafe",
    "cafe-2",
    "x".repeat(48),
    "x".repeat(46) + "-2",
    expect.stringMatching(/^profile-[a-f0-9]{8}$/),
  ]);
  expect(rows[0].name).toBe("Café");
  const shared = await created(catalog.create({ group: null, name: "Cafe" }));
  expect(shared.slug).toBe("cafe");
  expect(await createBrowserProfileCatalog(directory).list()).toEqual([...rows, shared]);
});

test("reports a typed code for each rejected create and an unreadable catalog", async () => {
  const catalog = createBrowserProfileCatalog(directory);
  const rejected = [
    [{ group, name: "  " }, "invalid"],
    [{ group, name: "a".repeat(81) }, "invalid"],
    [{ group: { serverId: "", projectId: "p" }, name: "Work" }, "invalid"],
    [{ group, name: "WS-hidden" }, "reserved"],
    [{ group: null, name: "Default" }, "reserved"],
  ] as const;
  for (const [input, code] of rejected) {
    expect(await catalog.create(input)).toEqual({ ok: false, code });
  }
  await created(catalog.create({ group, name: "Work" }));
  expect(await catalog.create({ group, name: "work" })).toEqual({ ok: false, code: "duplicate" });
  await writeFile(path.join(directory, "browser-profiles.json"), "{");
  expect(await catalog.create({ group, name: "Next" })).toEqual({ ok: false, code: "io" });
  await expect(catalog.list()).rejects.toThrow();
});

test("collisions with the bare project slug ws never allocate a reserved workspace key", async () => {
  const catalog = createBrowserProfileCatalog(directory);
  const first = await created(catalog.create({ group, name: "ws" }));
  const second = await created(catalog.create({ group, name: "wś" }));
  expect([first.slug, second.slug]).toEqual(["ws", "profile-ws-2"]);
  expect(await catalog.list()).toEqual([first, second]);
});

test("reserves the project's automatic workspace names without occupying them in Shared", async () => {
  const catalog = createBrowserProfileCatalog(directory);
  const workspaceNames = ["Main", "Release"];
  for (const name of ["  MAIN", "release"]) {
    expect(await catalog.create({ group, name, workspaceNames })).toEqual({
      ok: false,
      code: "duplicate",
    });
  }
  const shared = await created(catalog.create({ group: null, name: "Main", workspaceNames: [] }));
  expect(await catalog.list()).toEqual([shared]);
});

test("canonically equivalent spellings are one name; accented and plain names stay distinct", async () => {
  for (const [stored, entered] of [
    [composed, decomposed],
    [decomposed, composed],
  ]) {
    const catalog = createBrowserProfileCatalog(await mkdtemp(path.join(directory, "nfc-")));
    await created(catalog.create({ group, name: stored }));
    expect(await catalog.create({ group, name: entered })).toEqual({
      ok: false,
      code: "duplicate",
    });
    expect(await catalog.create({ group, name: entered, workspaceNames: [stored] })).toEqual({
      ok: false,
      code: "duplicate",
    });
  }
  const catalog = createBrowserProfileCatalog(await mkdtemp(path.join(directory, "plain-")));
  const accented = await created(catalog.create({ group, name: "Café" }));
  const plain = await created(catalog.create({ group, name: "Cafe" }));
  expect([accented.slug, plain.slug]).toEqual(["cafe", "cafe-2"]);
  expect(await catalog.list()).toEqual([accented, plain]);
});

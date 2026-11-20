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

test("concurrent creates allocate stable bounded keys inside their group", async () => {
  const catalog = createBrowserProfileCatalog(directory);
  const names = [" Café ", "Cafe", "x".repeat(48), "x".repeat(49), "公司"];
  const rows = await Promise.all(names.map((name) => catalog.create({ group, name })));
  expect(rows.map((row) => row.slug)).toEqual([
    "cafe",
    "cafe-2",
    "x".repeat(48),
    "x".repeat(46) + "-2",
    expect.stringMatching(/^profile-[a-f0-9]{8}$/),
  ]);
  expect(rows[0].name).toBe("Café");
  const shared = await catalog.create({ group: null, name: "Cafe" });
  expect(shared.slug).toBe("cafe");
  expect(await createBrowserProfileCatalog(directory).list()).toEqual([...rows, shared]);
});

test("rejects bad or duplicate names and preserves an unreadable catalog", async () => {
  const catalog = createBrowserProfileCatalog(directory);
  for (const input of [
    { group, name: "  " },
    { group, name: "a".repeat(81) },
    { group, name: "WS-hidden" },
    { group: null, name: "Default" },
  ]) {
    await expect(catalog.create(input)).rejects.toThrow();
  }
  await catalog.create({ group, name: "Work" });
  await expect(catalog.create({ group, name: "work" })).rejects.toThrow("Duplicate");
  await writeFile(path.join(directory, "browser-profiles.json"), "{");
  await expect(catalog.create({ group, name: "Next" })).rejects.toThrow();
  await expect(catalog.list()).rejects.toThrow();
});

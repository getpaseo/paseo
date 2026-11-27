import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { WorkspaceSnapshotStore } from "./workspace-snapshot-store.js";

describe("WorkspaceSnapshotStore", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "paseo-snapshots-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  test("a snapshot survives a new store over the same directory, until removed", async () => {
    await new WorkspaceSnapshotStore(dir).save("g1", "t1-a1", { "a.ts": "h1", "b.ts": "" });
    const reopened = new WorkspaceSnapshotStore(dir);
    await expect(reopened.load("g1", "t1-a1")).resolves.toEqual({ "a.ts": "h1", "b.ts": "" });
    await reopened.remove("g1", "t1-a1");
    await expect(reopened.load("g1", "t1-a1")).resolves.toBeNull();
  });

  test("a missing or damaged file reads as no snapshot", async () => {
    const store = new WorkspaceSnapshotStore(dir);
    await expect(store.load("g1", "nope")).resolves.toBeNull();
    await store.save("g1", "bad", {});
    await writeFile(path.join(dir, "g1", "bad.json"), '{"a": 1}', "utf8");
    await expect(store.load("g1", "bad")).resolves.toBeNull();
  });

  test("an id with slashes or dots stays inside its goal's folder", async () => {
    const store = new WorkspaceSnapshotStore(dir);
    await store.save("g1", "t1-a1", { "a.ts": "mine" });
    await store.save("g2", "../g1/t1-a1", { "a.ts": "other" });
    await store.save("../escape", "x", { "b.ts": "h" });
    await expect(store.load("g1", "t1-a1")).resolves.toEqual({ "a.ts": "mine" });
    await expect(store.load("g2", "../g1/t1-a1")).resolves.toEqual({ "a.ts": "other" });
    await store.remove("g2", "../g1/t1-a1");
    await expect(store.load("g1", "t1-a1")).resolves.toEqual({ "a.ts": "mine" });
    await expect(store.load("../escape", "x")).resolves.toEqual({ "b.ts": "h" });
    await expect(readdir(path.dirname(dir))).resolves.not.toContain("escape");
  });
});

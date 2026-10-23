import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isPlatform } from "../test-utils/platform.js";
import { createTestLogger } from "../test-utils/test-logger.js";
import { type PersistedTerminal, PersistedTerminalStore } from "./persisted-terminal-store.js";

function record(id: string, createdAt: string): PersistedTerminal {
  return {
    id,
    workspaceId: "ws-1",
    cwd: "/repo",
    name: id,
    command: "claude",
    args: ["--model", "opus"],
    agentSession: { provider: "claude", sessionId: `${id}-session` },
    createdAt,
    updatedAt: createdAt,
  };
}

describe("PersistedTerminalStore", () => {
  let dir: string;
  let store: PersistedTerminalStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "persisted-terminal-store-"));
    store = new PersistedTerminalStore(join(dir, "terminals"), createTestLogger());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes one file per terminal and lists them oldest first", async () => {
    await store.put(record("term-b", "2026-10-14T00:00:02.000Z"));
    await store.put(record("term-a", "2026-10-14T00:00:01.000Z"));

    expect(await readdir(join(dir, "terminals"))).toEqual(
      expect.arrayContaining(["term-a.json", "term-b.json"]),
    );
    expect(await store.list()).toEqual([
      record("term-a", "2026-10-14T00:00:01.000Z"),
      record("term-b", "2026-10-14T00:00:02.000Z"),
    ]);
  });

  it("deletes a record and clears all records", async () => {
    await store.put(record("term-a", "2026-10-14T00:00:01.000Z"));
    await store.put(record("term-b", "2026-10-14T00:00:02.000Z"));

    await store.delete("term-a");
    expect((await store.list()).map((entry) => entry.id)).toEqual(["term-b"]);

    await store.clear();
    expect(await store.list()).toEqual([]);
  });

  it("does not let a write that was in flight during clear land after it", async () => {
    await store.put(record("term-a", "2026-10-14T00:00:01.000Z"));

    const inFlight = store.put(record("term-b", "2026-10-14T00:00:02.000Z"));
    const queued = store.put({ ...record("term-a", "2026-10-14T00:00:01.000Z"), name: "renamed" });
    await store.clear();
    await Promise.all([inFlight, queued]);

    expect(await store.list()).toEqual([]);
  });

  it("keeps writes requested after clear", async () => {
    await store.put(record("term-a", "2026-10-14T00:00:01.000Z"));

    const cleared = store.clear();
    const after = store.put(record("term-b", "2026-10-14T00:00:02.000Z"));
    await Promise.all([cleared, after]);

    expect((await store.list()).map((entry) => entry.id)).toEqual(["term-b"]);
  });

  it("skips files that are not valid terminal records", async () => {
    await store.put(record("term-a", "2026-10-14T00:00:01.000Z"));
    await writeFile(join(dir, "terminals", "broken.json"), "{not json");
    await writeFile(join(dir, "terminals", "wrong.json"), JSON.stringify({ id: "wrong" }));

    expect((await store.list()).map((entry) => entry.id)).toEqual(["term-a"]);
  });

  it.skipIf(isPlatform("win32") || process.getuid?.() === 0)(
    "skips a record it cannot read and lists the others",
    async () => {
      await store.put(record("term-a", "2026-10-14T00:00:01.000Z"));
      const unreadable = join(dir, "terminals", "term-b.json");
      await writeFile(unreadable, JSON.stringify(record("term-b", "2026-10-14T00:00:02.000Z")));
      await chmod(unreadable, 0o000);

      expect((await store.list()).map((entry) => entry.id)).toEqual(["term-a"]);
    },
  );

  it("rejects terminal ids that are not safe file names", async () => {
    await expect(store.put(record("../escape", "2026-10-14T00:00:01.000Z"))).rejects.toThrow(
      "Invalid terminal id",
    );
  });
});

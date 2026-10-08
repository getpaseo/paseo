import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { KeeperEventOutbox, type KeeperEventInput } from "./event-outbox.js";

const dirs: string[] = [];

async function dir(): Promise<string> {
  const made = await mkdtemp(path.join(tmpdir(), "keeper-outbox-"));
  dirs.push(made);
  return made;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function input(agentId: string): KeeperEventInput {
  return {
    category: "lifecycle",
    type: "lifecycle.changed",
    agentId,
    bootId: "boot",
    sessionIncarnation: null,
    permissionGeneration: null,
    permissionRequestId: null,
    turnId: null,
    lifecycle: "idle",
  };
}

describe("KeeperEventOutbox", () => {
  test("an append after a torn tail survives the next restart", async () => {
    const d = await dir();
    const first = await KeeperEventOutbox.open(d);
    first.append(input("a"));
    await first.flush();
    await appendFile(path.join(d, "events.jsonl"), '{"eventId":"torn');
    const second = await KeeperEventOutbox.open(d);
    second.append(input("b"));
    await second.flush();
    const third = await KeeperEventOutbox.open(d);
    const page = await third.read(null, 10, 0);
    expect(page.events.map((e) => e.agentId)).toEqual(["a", "b"]);
  });

  test("continues sequence numbers and epoch across a restart", async () => {
    const d = await dir();
    const first = await KeeperEventOutbox.open(d);
    first.append(input("a"));
    first.append(input("b"));
    await first.flush();
    const cursor = (await first.read(null, 10, 0)).events[0]?.eventId ?? "";
    const second = await KeeperEventOutbox.open(d);
    second.append(input("c"));
    await second.flush();
    const page = await second.read(cursor, 10, 0);
    expect(page.events.map((e) => e.agentId)).toEqual(["b", "c"]);
    expect(page.events.map((e) => e.seq)).toEqual([2, 3]);
    expect(page.resyncRequired).toBe(false);
  });

  test("a read never returns an event that is not yet on disk", async () => {
    const outbox = await KeeperEventOutbox.open(await dir());
    outbox.append(input("a"));
    expect((await outbox.read(null, 10, 0)).events).toEqual([]);
    await outbox.flush();
    expect((await outbox.read(null, 10, 0)).events).toHaveLength(1);
  });

  test("long-poll wakes when an event is flushed", async () => {
    const outbox = await KeeperEventOutbox.open(await dir());
    const head = outbox.headCursor();
    const waiting = outbox.read(head, 10, 5_000);
    outbox.append(input("a"));
    expect((await waiting).events.map((e) => e.agentId)).toEqual(["a"]);
  });

  test("a foreign epoch or an evicted cursor demands a resync", async () => {
    const outbox = await KeeperEventOutbox.open(await dir(), { maxEvents: 2 });
    const start = outbox.headCursor();
    for (const id of ["a", "b", "c", "d"]) outbox.append(input(id));
    await outbox.flush();
    expect((await outbox.read("other.1", 10, 0)).resyncRequired).toBe(true);
    expect((await outbox.read(start, 10, 0)).resyncRequired).toBe(true);
    expect((await outbox.read(null, 10, 0)).events.map((e) => e.agentId)).toEqual(["c", "d"]);
  });

  test("a burst compacts only events already persisted to disk", async () => {
    const d = await dir();
    const outbox = await KeeperEventOutbox.open(d, { maxEvents: 2 });
    for (const id of ["a", "b", "c", "d", "e"]) outbox.append(input(id));
    await outbox.flush();
    const lines = (await readFile(path.join(d, "events.jsonl"), "utf8")).trim().split("\n");
    expect(lines.map((line) => JSON.parse(line).seq)).toEqual([4, 5]);
    const reopened = await KeeperEventOutbox.open(d, { maxEvents: 2 });
    expect((await reopened.read(null, 10, 0)).events.map((event) => event.agentId)).toEqual([
      "d",
      "e",
    ]);
    reopened.append(input("f"));
    await reopened.flush();
    expect((await reopened.read(null, 10, 0)).events.map((event) => event.seq)).toEqual([5, 6]);
  });

  test("a lost log starts a new epoch and a torn final line is dropped", async () => {
    const d = await dir();
    const first = await KeeperEventOutbox.open(d);
    first.append(input("a"));
    await first.flush();
    const oldHead = first.headCursor();
    await appendFile(path.join(d, "events.jsonl"), '{"eventId":"torn');
    const reopened = await KeeperEventOutbox.open(d);
    expect((await reopened.read(null, 10, 0)).events).toHaveLength(1);
    await rm(path.join(d, "events.jsonl"));
    const fresh = await KeeperEventOutbox.open(d);
    expect((await fresh.read(oldHead, 10, 0)).resyncRequired).toBe(true);
    await writeFile(path.join(d, "meta.json"), "not json");
    expect(await KeeperEventOutbox.open(d)).toBeInstanceOf(KeeperEventOutbox);
  });
});

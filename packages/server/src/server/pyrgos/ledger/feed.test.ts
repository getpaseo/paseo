import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  announceLine,
  createAnnouncer,
  createVoiceSession,
  ReplyPump,
  ReplyWatcher,
  TurnGate,
} from "./feed.js";
import type { LedgerItem } from "./ledger.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ledger-feed-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function item(text: string): LedgerItem {
  return {
    id: "a1",
    state: "agreed",
    item: text,
    scope: "s",
    project: "p",
    doneCriteria: "d",
    transcriptRef: null,
    launchError: null,
    dropReason: null,
    createdAt: "t",
    updatedAt: "t",
  };
}

describe("announceLine", () => {
  it("formats one line with the transcript ref", () => {
    expect(announceLine({ item: "ship\nit", ref: "a.jsonl#3" })).toBe(
      "[voice] ACTION: ship it (transcript: a.jsonl#3)",
    );
  });

  it("caps long lines at 400 chars with an ellipsis and keeps the ref", () => {
    const line = announceLine({ item: "x".repeat(900), ref: "a.jsonl#3" });
    expect(line.length).toBeLessThanOrEqual(400);
    expect(line).toContain("…");
    expect(line.endsWith("(transcript: a.jsonl#3)")).toBe(true);
  });

  it("stays within 400 chars even when the ref is very long", () => {
    const ref = `${"d/".repeat(300)}a.jsonl#3`;
    const line = announceLine({ item: "ship it", ref });
    expect(line.length).toBeLessThanOrEqual(400);
    expect(line.endsWith("a.jsonl#3)")).toBe(true);
  });
});

describe("VoiceSession", () => {
  it("returns 1-based line numbers", async () => {
    const session = createVoiceSession({ dir, session: "s1" });
    expect(await session.append("user", "hi")).toBe(1);
    expect(await session.append("assistant", "hello")).toBe(2);
    const rows = (await readFile(session.path, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(rows.map((r) => r.speaker)).toEqual(["user", "assistant"]);
  });

  it("gives unique line numbers under concurrent writers from separate sessions", async () => {
    const a = createVoiceSession({ dir, session: "s2" });
    const b = createVoiceSession({ dir, session: "s2" });
    const lines = await Promise.all(
      Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).append("user", `m${i}`)),
    );
    expect([...lines].sort((x, y) => x - y)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });
});

describe("createAnnouncer", () => {
  it("sends through wmux when a surface is set", async () => {
    const session = createVoiceSession({ dir, session: "s3" });
    const exec = vi.fn(async () => {});
    const announce = createAnnouncer({
      session,
      env: { VOICE_OVERSEER_SURFACE: "surface:1" },
      exec,
      inboxPath: join(dir, "inbox.md"),
    });
    await announce(item("do thing"));
    expect(exec).toHaveBeenCalledWith("wmux", [
      "send",
      "surface:1",
      `[voice] ACTION: do thing (transcript: ${session.path}#1)`,
    ]);
    expect((await readFile(session.path, "utf8")).includes('"speaker":"action"')).toBe(true);
  });

  it("falls back to the inbox file off the PC", async () => {
    const session = createVoiceSession({ dir, session: "s4" });
    const exec = vi.fn(async () => {});
    const inboxPath = join(dir, "inbox.md");
    await createAnnouncer({ session, env: {}, exec, inboxPath })(item("do thing"));
    expect(exec).not.toHaveBeenCalled();
    expect(await readFile(inboxPath, "utf8")).toBe(
      `[voice] ACTION: do thing (transcript: ${session.path}#1)\n`,
    );
  });
});

describe("ReplyWatcher", () => {
  it("returns each complete line once and waits for partial lines", async () => {
    const path = join(dir, "r.replies.jsonl");
    const watcher = new ReplyWatcher(path);
    expect(await watcher.poll()).toEqual([]);
    await appendFile(path, `${JSON.stringify({ ts: "t", text: "one" })}\n{"text":"tw`);
    expect(await watcher.poll()).toEqual(["one"]);
    expect(await watcher.poll()).toEqual([]);
    await appendFile(path, 'o"}\n');
    expect(await watcher.poll()).toEqual(["two"]);
  });

  it("skips malformed lines and keeps polling", async () => {
    const path = join(dir, "m.replies.jsonl");
    const watcher = new ReplyWatcher(path);
    await appendFile(path, `not json\n${JSON.stringify({ ts: "t", text: "ok" })}\n`);
    expect(await watcher.poll()).toEqual(["ok"]);
    await appendFile(path, `${JSON.stringify({ ts: "t", text: "later" })}\n`);
    expect(await watcher.poll()).toEqual(["later"]);
  });
});

describe("TurnGate", () => {
  it("is idle only when nothing is busy and the hold has expired", () => {
    let t = 0;
    const gate = new TurnGate(() => t);
    expect(gate.idle()).toBe(true);
    gate.set("user", true);
    expect(gate.idle()).toBe(false);
    gate.set("user", false);
    gate.hold(20);
    expect(gate.idle()).toBe(false);
    t = 20_000;
    expect(gate.idle()).toBe(true);
  });
});

describe("ReplyPump", () => {
  it("holds replies while busy and speaks them once idle", async () => {
    const session = createVoiceSession({ dir, session: "s5" });
    await appendFile(session.repliesPath, `${JSON.stringify({ text: "go ahead" })}\n`);
    const gate = new TurnGate();
    gate.set("bot", true);
    const speak = vi.fn(async () => {});
    const pump = new ReplyPump({
      watcher: new ReplyWatcher(session.repliesPath),
      gate,
      session,
      speak,
    });
    expect(await pump.pump()).toEqual([]);
    expect(speak).not.toHaveBeenCalled();
    gate.set("bot", false);
    expect(await pump.pump()).toEqual(["go ahead"]);
    expect(speak).toHaveBeenCalledWith("The overseer says: go ahead");
    expect(await pump.pump()).toEqual([]);
  });
});

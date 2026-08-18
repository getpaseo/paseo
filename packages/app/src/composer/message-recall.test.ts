import { beforeEach, describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import {
  collectSentMessages,
  forgetRecallState,
  readRecallHistory,
  readRecallSession,
  rememberSentPrompt,
  writeRecallSession,
  resolveRecall,
  resolveRecallDirection,
  type RecallSession,
  type RecallSnapshot,
} from "./message-recall";

function sent(id: string, text: string): StreamItem {
  return { kind: "user_message", id, text, timestamp: new Date(0) };
}

function replied(id: string, text: string): StreamItem {
  return { kind: "assistant_message", id, text, timestamp: new Date(0) };
}

/** A composer holding `text` with the caret at `caret`, defaulting to the end. */
function holding(text: string, caret = text.length): RecallSnapshot {
  return { text, selection: { start: caret, end: caret } };
}

const EMPTY = holding("");

describe("collectSentMessages", () => {
  it("reads the user's own messages, newest first", () => {
    expect(
      collectSentMessages([
        sent("1", "first"),
        replied("2", "a reply"),
        sent("3", "second"),
        replied("4", "another reply"),
        sent("5", "third"),
      ]),
    ).toEqual(["third", "second", "first"]);
  });

  it("drops blank messages and adjacent repeats", () => {
    expect(
      collectSentMessages([
        sent("1", "keep"),
        sent("2", "   "),
        sent("3", "repeat"),
        sent("4", "repeat"),
      ]),
    ).toEqual(["repeat", "keep"]);
  });

  it("keeps a repeat that is not adjacent", () => {
    expect(collectSentMessages([sent("1", "run"), sent("2", "fix"), sent("3", "run")])).toEqual([
      "run",
      "fix",
      "run",
    ]);
  });

  it("trims each entry so the recalled text is what gets sent", () => {
    expect(collectSentMessages([sent("1", "  padded  ")])).toEqual(["padded"]);
  });

  it("is empty without a timeline, or without user messages in it", () => {
    expect(collectSentMessages(undefined)).toEqual([]);
    expect(collectSentMessages([])).toEqual([]);
    expect(collectSentMessages([replied("1", "hello")])).toEqual([]);
  });

  it("stops at 100 entries on a long timeline", () => {
    const items = Array.from({ length: 250 }, (_, index) => sent(`${index}`, `message ${index}`));
    const history = collectSentMessages(items);
    expect(history).toHaveLength(100);
    expect(history[0]).toBe("message 249");
    expect(history[99]).toBe("message 150");
  });
});

describe("readRecallHistory", () => {
  const agent = { serverId: "host", agentId: "agent-1" };

  beforeEach(() => {
    forgetRecallState();
  });

  it("reaches past the loaded timeline page, newest first", () => {
    // The loaded page holds one turn's prompt; the rest is only known because this client sent it.
    rememberSentPrompt({ ...agent, text: "run the suite" });
    rememberSentPrompt({ ...agent, text: "fix the flaky assertion" });
    rememberSentPrompt({ ...agent, text: "rebase onto main" });

    expect(readRecallHistory({ ...agent, timeline: [sent("1", "rebase onto main")] })).toEqual([
      "rebase onto main",
      "fix the flaky assertion",
      "run the suite",
    ]);
  });

  it("falls back to the timeline for an agent this client has not sent to", () => {
    expect(readRecallHistory({ ...agent, timeline: [sent("1", "from another device")] })).toEqual([
      "from another device",
    ]);
  });

  it("keeps prompts apart per agent and per host", () => {
    rememberSentPrompt({ ...agent, text: "mine" });
    expect(readRecallHistory({ serverId: "host", agentId: "agent-2", timeline: [] })).toEqual([]);
    expect(readRecallHistory({ serverId: "other", agentId: "agent-1", timeline: [] })).toEqual([]);
    expect(readRecallHistory({ ...agent, timeline: [] })).toEqual(["mine"]);
  });

  it("ignores blank prompts and repeats of the last one", () => {
    rememberSentPrompt({ ...agent, text: "  " });
    rememberSentPrompt({ ...agent, text: "again" });
    rememberSentPrompt({ ...agent, text: "again" });
    expect(readRecallHistory({ ...agent, timeline: [] })).toEqual(["again"]);
  });

  it("trims what it remembers, so recall matches what was sent", () => {
    rememberSentPrompt({ ...agent, text: "  padded  " });
    expect(readRecallHistory({ ...agent, timeline: [] })).toEqual(["padded"]);
  });

  it("stops at 100 entries across both sources", () => {
    for (let index = 0; index < 120; index += 1) {
      rememberSentPrompt({ ...agent, text: `sent ${index}` });
    }
    const history = readRecallHistory({ ...agent, timeline: [sent("x", "from the timeline")] });
    expect(history).toHaveLength(100);
    expect(history[0]).toBe("sent 119");
    expect(history).not.toContain("from the timeline");
  });
});

describe("resolveRecallDirection", () => {
  it("claims a bare Up and Down", () => {
    expect(resolveRecallDirection({ key: "ArrowUp" })).toBe("older");
    expect(resolveRecallDirection({ key: "ArrowDown" })).toBe("newer");
  });

  it("leaves modified arrows to the platform and to Paseo's shortcuts", () => {
    expect(resolveRecallDirection({ key: "ArrowUp", metaKey: true })).toBeNull();
    expect(resolveRecallDirection({ key: "ArrowUp", ctrlKey: true })).toBeNull();
    expect(resolveRecallDirection({ key: "ArrowUp", altKey: true })).toBeNull();
    expect(resolveRecallDirection({ key: "ArrowDown", shiftKey: true })).toBeNull();
  });

  it("ignores every other key", () => {
    expect(resolveRecallDirection({ key: "Enter" })).toBeNull();
    expect(resolveRecallDirection({ key: "ArrowLeft" })).toBeNull();
    expect(resolveRecallDirection({ key: "a" })).toBeNull();
  });
});

describe("resolveRecall", () => {
  const history = ["newest", "middle", "oldest"];

  function walkTo(index: number, stash: RecallSnapshot = EMPTY): RecallSession {
    const recalled = history[index];
    if (recalled === undefined) throw new Error(`no history entry at ${index}`);
    return { index, recalled, stash };
  }

  it("recalls the last sent message from an empty composer", () => {
    expect(resolveRecall({ history, session: null, snapshot: EMPTY, direction: "older" })).toEqual({
      session: { index: 0, recalled: "newest", stash: EMPTY },
      text: "newest",
      selection: { start: 6, end: 6 },
    });
  });

  it("walks back through every entry and stops at the oldest", () => {
    expect(
      resolveRecall({
        history,
        session: walkTo(0),
        snapshot: holding("newest"),
        direction: "older",
      }),
    ).toMatchObject({ text: "middle", session: { index: 1 } });
    expect(
      resolveRecall({
        history,
        session: walkTo(2),
        snapshot: holding("oldest"),
        direction: "older",
      }),
    ).toBeNull();
  });

  it("puts the caret at the end of the recalled message", () => {
    const outcome = resolveRecall({
      history,
      session: null,
      snapshot: EMPTY,
      direction: "older",
    });
    expect(outcome?.selection).toEqual({ start: "newest".length, end: "newest".length });
  });

  it("stashes what the user was writing and gives it back on the way forward", () => {
    const draft = holding("half typed");
    const entered = resolveRecall({ history, session: null, snapshot: draft, direction: "older" });
    expect(entered).toMatchObject({ text: "newest", session: { stash: draft } });

    const returned = resolveRecall({
      history,
      session: entered?.session ?? null,
      snapshot: holding("newest"),
      direction: "newer",
    });
    expect(returned).toEqual({ session: null, text: "half typed", selection: draft.selection });
  });

  it("gives the stashed caret back too, not just the text", () => {
    const draft = holding("half typed", 4);
    const returned = resolveRecall({
      history,
      session: walkTo(0, draft),
      snapshot: holding("newest"),
      direction: "newer",
    });
    expect(returned?.selection).toEqual({ start: 4, end: 4 });
  });

  it("carries the stash across the whole walk", () => {
    const draft = holding("half typed");
    const deeper = resolveRecall({
      history,
      session: walkTo(0, draft),
      snapshot: holding("newest"),
      direction: "older",
    });
    expect(deeper?.session?.stash).toEqual(draft);
  });

  it("does nothing on Down while the composer is on the user's own text", () => {
    expect(
      resolveRecall({ history, session: null, snapshot: EMPTY, direction: "newer" }),
    ).toBeNull();
    expect(
      resolveRecall({ history, session: null, snapshot: holding("typed"), direction: "newer" }),
    ).toBeNull();
  });

  it("moves the caret instead of recalling when there is a line above", () => {
    const twoLines = holding("first line\nsecond line");
    expect(resolveRecall({ history, session: null, snapshot: twoLines, direction: "older" })).toBe(
      null,
    );
    // Same text, caret on the first line: nothing above it, so recall takes the key.
    expect(
      resolveRecall({
        history,
        session: null,
        snapshot: holding("first\nsecond", 3),
        direction: "older",
      }),
    ).toMatchObject({ text: "newest" });
  });

  it("moves the caret instead of walking forward when there is a line below", () => {
    const recalled = "line one\nline two";
    const session: RecallSession = { index: 1, recalled, stash: EMPTY };
    const withLineBelow = { history: ["newest", recalled], session, direction: "newer" as const };
    expect(resolveRecall({ ...withLineBelow, snapshot: holding(recalled, 2) })).toBeNull();
    expect(resolveRecall({ ...withLineBelow, snapshot: holding(recalled) })).toMatchObject({
      text: "newest",
    });
  });

  it("leaves a range selection to the platform", () => {
    expect(
      resolveRecall({
        history,
        session: null,
        snapshot: { text: "", selection: { start: 0, end: 3 } },
        direction: "older",
      }),
    ).toBeNull();
  });

  it("starts a new walk, stashing the edit, once the recalled text is changed", () => {
    const edited = holding("newest plus a note");
    expect(
      resolveRecall({ history, session: walkTo(0), snapshot: edited, direction: "older" }),
    ).toMatchObject({ text: "newest", session: { index: 0, stash: edited } });
    expect(
      resolveRecall({ history, session: walkTo(0), snapshot: edited, direction: "newer" }),
    ).toBeNull();
  });

  it("starts a new walk when history moved underneath the old one", () => {
    const session: RecallSession = { index: 1, recalled: "middle", stash: EMPTY };
    const shifted = ["brand new", "newest", "middle", "oldest"];
    expect(
      resolveRecall({ history: shifted, session, snapshot: holding("middle"), direction: "older" }),
    ).toMatchObject({ text: "brand new", session: { index: 0 } });
  });

  it("does nothing when the agent has no messages yet", () => {
    expect(resolveRecall({ history: [], session: null, snapshot: EMPTY, direction: "older" })).toBe(
      null,
    );
  });
});

describe("the walk, per agent", () => {
  const agent = { serverId: "host", agentId: "agent-1" };
  const session: RecallSession = {
    index: 0,
    recalled: "rebase onto main",
    stash: holding("half typed"),
  };

  beforeEach(() => {
    forgetRecallState();
  });

  it("survives the composer, because more than one is mounted for the same agent", () => {
    writeRecallSession({ ...agent, session });
    expect(readRecallSession(agent)).toEqual(session);
  });

  it("is not shared between agents", () => {
    writeRecallSession({ ...agent, session });
    expect(readRecallSession({ serverId: "host", agentId: "agent-2" })).toBeNull();
  });

  it("is dropped once the composer is back on the user's own text", () => {
    writeRecallSession({ ...agent, session });
    writeRecallSession({ ...agent, session: null });
    expect(readRecallSession(agent)).toBeNull();
  });
});

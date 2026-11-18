import { describe, expect, it } from "vitest";
import type { StreamItem, ToolCallItem } from "@/types/stream";
import { collapseTurns, type CollapseTurnsInput } from "./model";

const at = new Date("2026-01-01T00:00:00.000Z");

function user(id: string): StreamItem {
  return { kind: "user_message", id, text: id, timestamp: at };
}

function reply(id: string): StreamItem {
  return { kind: "assistant_message", id, text: id, timestamp: at };
}

function pluginReply(sourceId: string, part = "0"): StreamItem {
  return {
    kind: "plugin",
    id: `math/${sourceId}/${part}`,
    sourceId,
    sourceKind: "assistant_message",
    timestamp: at,
    pluginId: "math",
    pluginItemId: `${sourceId}/${part}`,
    itemKind: "formula",
    version: 1,
    data: { text: "$$x^2$$" },
  };
}

function thought(id: string): StreamItem {
  return { kind: "thought", id, text: id, timestamp: at, status: "ready" };
}

function shell(id: string): ToolCallItem {
  return {
    kind: "tool_call",
    id,
    timestamp: at,
    payload: {
      source: "agent",
      data: {
        provider: "claude",
        callId: id,
        name: "Bash",
        status: "completed",
        error: null,
        detail: { type: "shell", command: "ls" },
      },
    },
  };
}

function collapse(tail: StreamItem[], options: Partial<CollapseTurnsInput> = {}) {
  return collapseTurns({
    tail,
    isLatestTurnOpen: false,
    expandedHostIds: new Set(),
    getGroupedCalls: () => undefined,
    previousSummaryRowsByHostId: new Map(),
    ...options,
  });
}

const ids = (items: StreamItem[]) => items.map((item) => item.id);

describe("collapseTurns", () => {
  it("keeps every card of the final reply outside the folded turn", () => {
    const items = [
      user("prompt"),
      reply("acknowledgment"),
      shell("call"),
      pluginReply("final", "left"),
      pluginReply("final", "right"),
    ];
    const result = collapse(items);
    expect(ids(result.tail)).toEqual([
      "prompt",
      "turn-summary:prompt",
      "math/final/left",
      "math/final/right",
    ]);
    expect(result.hostIdByFoldedMessageId.get("acknowledgment")).toBe("prompt");
    expect(result.hostIdByFoldedMessageId.has("final")).toBe(false);
    const expanded = collapse(items, { expandedHostIds: new Set(["prompt"]) });
    expect(ids(expanded.tail)).toEqual([
      "prompt",
      "turn-summary:prompt",
      "acknowledgment",
      "call",
      "math/final/left",
      "math/final/right",
    ]);
    expect([...expanded.nestedItemIds]).toEqual(["acknowledgment", "call"]);
  });

  it("folds intermediate plugin replies even without tool calls", () => {
    const result = collapse([user("prompt"), pluginReply("intermediate"), pluginReply("final")]);
    expect(ids(result.tail)).toEqual(["prompt", "turn-summary:prompt", "math/final/0"]);
    expect(result.hostIdByFoldedMessageId.get("intermediate")).toBe("prompt");
  });

  it.each([undefined, "thought", "tool_call"] as const)(
    "does not treat a plugin row with source kind %s as a reply",
    (sourceKind) => {
      const card = { ...pluginReply("card"), sourceKind };
      const items = [user("prompt"), shell("call"), card];
      expect(collapse(items).tail).toEqual(items);
      expect(collapse(items).summaryRowsByHostId.size).toBe(0);
    },
  );

  it("keeps a plugin-rendered reply and its work unfolded while the turn is open", () => {
    const items = [user("prompt"), shell("call"), pluginReply("final")];
    expect(collapse(items, { isLatestTurnOpen: true }).tail).toEqual(items);
  });

  // A mounted row renders again only when its item changes, so a turn whose work and open state
  // are unchanged keeps its summary row object across folds of the same history.
  it("keeps a summary row until its turn's work or open state changes", () => {
    const first = collapse([user("u1"), shell("c1"), reply("r1"), user("u2"), shell("c2")], {
      isLatestTurnOpen: true,
    });
    const closed = collapse(
      [user("u1"), shell("c1"), reply("r1"), user("u2"), shell("c2"), reply("r2")],
      { previousSummaryRowsByHostId: first.summaryRowsByHostId },
    );
    expect(closed.summaryRowsByHostId.get("u1")).toBe(first.summaryRowsByHostId.get("u1"));
    const moreWork = collapse(
      [user("u1"), shell("c1"), reply("r1"), user("u2"), shell("c2"), shell("c3"), reply("r2")],
      { previousSummaryRowsByHostId: closed.summaryRowsByHostId },
    );
    expect(moreWork.summaryRowsByHostId.get("u1")).toBe(closed.summaryRowsByHostId.get("u1"));
    expect(moreWork.summaryRowsByHostId.get("u2")).not.toBe(closed.summaryRowsByHostId.get("u2"));
    const opened = collapse(moreWork.tail, {
      previousSummaryRowsByHostId: moreWork.summaryRowsByHostId,
      expandedHostIds: new Set(["u1"]),
    });
    expect(opened.summaryRowsByHostId.get("u1")).not.toBe(moreWork.summaryRowsByHostId.get("u1"));
  });
  it("stands at its host's timeline position, taking a new row when that position lands", () => {
    const live = collapse([user("u1"), shell("c1"), reply("r1")]);
    expect(live.summaryRowsByHostId.get("u1")).not.toHaveProperty("timelineCursor");
    const cursor = { epoch: "epoch-1", seq: 7 };
    const placed = [{ ...user("u1"), timelineCursor: cursor }, shell("c1"), reply("r1")];
    const canonical = collapse(placed, { previousSummaryRowsByHostId: live.summaryRowsByHostId });
    expect(canonical.summaryRowsByHostId.get("u1")).not.toBe(live.summaryRowsByHostId.get("u1"));
    expect(canonical.summaryRowsByHostId.get("u1")?.timelineCursor).toEqual(cursor);
    const again = collapse(placed, { previousSummaryRowsByHostId: canonical.summaryRowsByHostId });
    expect(again.summaryRowsByHostId.get("u1")).toBe(canonical.summaryRowsByHostId.get("u1"));
  });
  it("maps hidden rows to their turn's host only while the turn is closed", () => {
    const result = collapse([user("u1"), shell("c1"), reply("final")]);
    expect(result.hostIdByHiddenRowId.get("c1")).toBe("u1");
    const expanded = collapse([user("u1"), shell("c1"), reply("final")], {
      expandedHostIds: new Set(["u1"]),
    });
    expect(expanded.hostIdByHiddenRowId.size).toBe(0);
  });
  it("keeps lifecycle events and compaction recognizable beside a semantic action summary", () => {
    const create = shell("create");
    if (create.payload.source !== "agent") throw new Error("Expected agent tool");
    create.payload.data.name = "mcp__paseo__create_agent";
    create.payload.data.detail = { type: "unknown", input: { title: "Side fix" }, output: null };
    const finished = shell("finished");
    if (finished.payload.source !== "agent") throw new Error("Expected agent tool");
    finished.payload.data.name = "agent_notification";
    finished.payload.data.agentMessage = {
      event: "finished",
      sender: { id: "worker", title: "PR helper" },
      text: "Finished",
    };
    const items: StreamItem[] = [
      user("u1"),
      create,
      finished,
      {
        kind: "compaction",
        id: "compaction",
        timestamp: at,
        status: "completed",
      } satisfies StreamItem,
      shell("bash"),
      reply("done"),
    ].map((item) => Object.assign(item, { turnId: "same-run" }));
    const result = collapse(items);
    expect(ids(result.tail)).toEqual(["u1", "turn-summary:u1", "finished", "compaction", "done"]);
    expect(result.summaryRowsByHostId.get("u1")?.tools).toMatchObject({
      commandCount: 1,
      otherToolCount: 0,
      paseoActions: { "Created agent": 1 },
    });
  });

  it("folds a finished turn's work into a summary row under its user message and keeps the reply", () => {
    const result = collapse([
      user("u1"),
      thought("t1"),
      reply("early"),
      shell("c1"),
      shell("c2"),
      reply("final"),
    ]);

    expect(ids(result.tail)).toEqual(["u1", "turn-summary:u1", "final"]);
    expect(result.tail[1]).toEqual({
      kind: "turn_summary",
      id: "turn-summary:u1",
      hostId: "u1",
      timestamp: at,
      expanded: false,
      tools: expect.objectContaining({ commandCount: 2 }),
    });
    expect(result.summaryRowsByHostId.get("u1")).toBe(result.tail[1]);
    expect(result.hostIdByFoldedMessageId.get("early")).toBe("u1");
  });

  it("shows an expanded turn's work as nested rows between the prompt and the reply", () => {
    const result = collapse([user("u1"), thought("t1"), shell("c1"), reply("final")], {
      expandedHostIds: new Set(["u1"]),
    });

    expect(ids(result.tail)).toEqual(["u1", "turn-summary:u1", "t1", "c1", "final"]);
    expect([...result.nestedItemIds]).toEqual(["t1", "c1"]);
    expect(result.summaryRowsByHostId.get("u1")?.expanded).toBe(true);
  });

  it("leaves the latest turn alone while it is still producing output", () => {
    const tail = [user("u1"), shell("c1"), reply("r1"), user("u2"), shell("c2"), reply("r2")];

    const result = collapse(tail, { isLatestTurnOpen: true });

    expect(ids(result.tail)).toEqual(["u1", "turn-summary:u1", "r1", "u2", "c2", "r2"]);
    expect([...result.summaryRowsByHostId.keys()]).toEqual(["u1"]);
  });

  it("keeps rows after the reply, and turns with no work before the reply, as they are", () => {
    const result = collapse([
      user("u1"),
      shell("c1"),
      reply("r1"),
      shell("after"),
      user("u2"),
      reply("r2"),
    ]);

    expect(ids(result.tail)).toEqual(["u1", "turn-summary:u1", "r1", "after", "u2", "r2"]);
    expect([...result.summaryRowsByHostId.keys()]).toEqual(["u1"]);
  });

  it("does not fold a turn that only thought before its reply", () => {
    const tail = [user("u1"), thought("t1"), reply("r1")];

    const result = collapse(tail);

    expect(result.tail).toBe(tail);
    expect(result.summaryRowsByHostId.size).toBe(0);
  });

  it("does not fold a turn without a reply or whose prompt is above the loaded history", () => {
    const tail = [shell("c0"), reply("r0"), user("u1"), shell("c1")];

    const result = collapse(tail);

    expect(result.tail).toBe(tail);
    expect(result.summaryRowsByHostId.size).toBe(0);
  });

  it("keeps a completed response folded when a promptless canonical turn starts", () => {
    const first = [user("u1"), shell("c1"), reply("r1")].map((item) =>
      Object.assign(item, { turnId: "first" }),
    );
    const next = { ...shell("heartbeat"), turnId: "second" };
    const result = collapse([...first, next], { isLatestTurnOpen: true });
    expect(ids(result.tail)).toEqual(["u1", "turn-summary:u1", "r1", "heartbeat"]);
    expect(result.tail[1]).toMatchObject({ kind: "turn_summary", turnId: "first" });
  });

  it("keeps mid-turn messages visible when work is folded", () => {
    const tail = [user("prompt"), shell("work"), user("steer"), shell("more"), reply("done")];
    for (const item of tail) item.turnId = "same-turn";
    const result = collapse(tail);
    expect(ids(result.tail)).toEqual(["prompt", "turn-summary:prompt", "steer", "done"]);
    expect(result.hostIdByFoldedMessageId.has("steer")).toBe(false);
  });

  it("reveals every raw call inside an expanded turn", () => {
    const calls = [shell("one"), shell("two")];
    const result = collapse([user("prompt"), calls[0]!, reply("done")], {
      expandedHostIds: new Set(["prompt"]),
      getGroupedCalls: (id) => (id === "one" ? calls : undefined),
    });
    expect(ids(result.tail)).toEqual(["prompt", "turn-summary:prompt", "one", "two", "done"]);
    expect([...result.nestedItemIds]).toEqual(["one", "two"]);
  });

  it("counts every call a tool-call group row stands for", () => {
    const group = [shell("c1"), shell("c2"), shell("c3")];
    const result = collapse([user("u1"), group[0]!, reply("final")], {
      getGroupedCalls: (itemId) => (itemId === "c1" ? group : undefined),
    });

    expect(result.summaryRowsByHostId.get("u1")?.tools).toMatchObject({ commandCount: 3 });
  });
});

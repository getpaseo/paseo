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
    ...options,
  });
}

const ids = (items: StreamItem[]) => items.map((item) => item.id);

describe("collapseTurns", () => {
  it("folds a finished turn's work into its user message and keeps the reply", () => {
    const result = collapse([
      user("u1"),
      thought("t1"),
      reply("early"),
      shell("c1"),
      shell("c2"),
      reply("final"),
    ]);

    expect(ids(result.tail)).toEqual(["u1", "final"]);
    expect(result.turnsByHostId.get("u1")).toEqual({
      hostId: "u1",
      expanded: false,
      summary: {
        messageCount: 1,
        tools: expect.objectContaining({ commandCount: 2 }),
      },
    });
    expect(result.hostIdByFoldedMessageId.get("early")).toBe("u1");
  });

  it("shows an expanded turn's work as nested rows between the prompt and the reply", () => {
    const result = collapse([user("u1"), thought("t1"), shell("c1"), reply("final")], {
      expandedHostIds: new Set(["u1"]),
    });

    expect(ids(result.tail)).toEqual(["u1", "t1", "c1", "final"]);
    expect([...result.nestedItemIds]).toEqual(["t1", "c1"]);
    expect(result.turnsByHostId.get("u1")?.expanded).toBe(true);
  });

  it("leaves the latest turn alone while it is still producing output", () => {
    const tail = [user("u1"), shell("c1"), reply("r1"), user("u2"), shell("c2"), reply("r2")];

    const result = collapse(tail, { isLatestTurnOpen: true });

    expect(ids(result.tail)).toEqual(["u1", "r1", "u2", "c2", "r2"]);
    expect([...result.turnsByHostId.keys()]).toEqual(["u1"]);
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

    expect(ids(result.tail)).toEqual(["u1", "r1", "after", "u2", "r2"]);
    expect([...result.turnsByHostId.keys()]).toEqual(["u1"]);
  });

  it("does not fold a turn that only thought before its reply", () => {
    const tail = [user("u1"), thought("t1"), reply("r1")];

    const result = collapse(tail);

    expect(result.tail).toBe(tail);
    expect(result.turnsByHostId.size).toBe(0);
  });

  it("does not fold a turn without a reply or whose prompt is above the loaded history", () => {
    const tail = [shell("c0"), reply("r0"), user("u1"), shell("c1")];

    const result = collapse(tail);

    expect(result.tail).toBe(tail);
    expect(result.turnsByHostId.size).toBe(0);
  });

  it("counts every call a tool-call group row stands for", () => {
    const group = [shell("c1"), shell("c2"), shell("c3")];
    const result = collapse([user("u1"), group[0]!, reply("final")], {
      getGroupedCalls: (itemId) => (itemId === "c1" ? group : undefined),
    });

    expect(result.turnsByHostId.get("u1")?.summary).toMatchObject({
      tools: { commandCount: 3 },
    });
  });
});

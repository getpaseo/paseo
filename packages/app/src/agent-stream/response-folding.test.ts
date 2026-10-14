import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { projectResponseFolding } from "./response-folding";

const timestamp = new Date("2026-10-03T10:00:00Z");
function message(
  id: string,
  kind: "user_message" | "assistant_message" = "assistant_message",
): Extract<StreamItem, { kind: "user_message" | "assistant_message" }> {
  return { kind, id, text: id, timestamp };
}

describe("completed response folding", () => {
  it("retains history projection while only the active response text changes", () => {
    const items = [
      message("u1", "user_message"),
      message("step"),
      message("final"),
      message("u2", "user_message"),
      message("live"),
    ];
    const input = {
      items,
      isTurnActive: true,
      activeTurnId: null,
      expandedResponseIds: new Set<string>(),
    };
    const previous = projectResponseFolding(input);
    const updated = projectResponseFolding({
      ...input,
      items: [...items.slice(0, -1), { ...message("live"), text: "More streamed text" }],
      previous,
    });
    expect(updated).toBe(previous);
    expect(
      projectResponseFolding({
        ...input,
        isTurnActive: false,
        items: [...items, message("new-final")],
        previous,
      }),
    ).not.toBe(previous);
  });
  it("counts the tool calls represented by an overview row and keeps errors visible", () => {
    const items: StreamItem[] = [
      message("user", "user_message"),
      { kind: "thought", id: "thought", text: "Inspecting", status: "ready", timestamp },
      {
        kind: "tool_call",
        id: "tools",
        timestamp,
        payload: {
          source: "orchestrator",
          data: { toolCallId: "tools", toolName: "Shell", arguments: {}, status: "completed" },
        },
      },
      {
        kind: "notification",
        id: "error",
        timestamp,
        sourceType: "error",
        level: "error",
        message: "Check failed",
      },
      message("final"),
    ];
    const result = projectResponseFolding({
      items,
      isTurnActive: false,
      activeTurnId: null,
      expandedResponseIds: new Set(),
      toolCallCount: () => 5,
    });
    expect(result.headersByHostId.get("thought")?.count).toBe(6);
    expect([...result.hiddenItemIds]).toEqual(["tools"]);
  });
  it("leaves an active response open while folding earlier responses independently", () => {
    const items = [
      message("u1", "user_message"),
      message("s1"),
      message("f1"),
      message("u2", "user_message"),
      message("s2"),
      message("f2"),
    ];
    const active = projectResponseFolding({
      items,
      isTurnActive: true,
      activeTurnId: null,
      expandedResponseIds: new Set(),
    });
    expect([...active.headersByHostId.keys()]).toEqual(["s1"]);
    const complete = projectResponseFolding({
      items,
      isTurnActive: false,
      activeTurnId: null,
      expandedResponseIds: new Set(["f1"]),
    });
    expect([...complete.headersByHostId.values()]).toEqual([
      { responseId: "f1", count: 1, expanded: true },
      { responseId: "f2", count: 1, expanded: false },
    ]);
  });
  it("keeps active steps visible across a user steering message", () => {
    const items = [
      message("u1", "user_message"),
      message("s1"),
      message("s2"),
      message("u2", "user_message"),
      message("s3"),
    ];
    for (const item of items) item.turnId = "active";
    expect(
      projectResponseFolding({
        items,
        isTurnActive: true,
        activeTurnId: "active",
        expandedResponseIds: new Set(),
      }).headersByHostId.size,
    ).toBe(0);
  });
  it("has no disclosure for a final answer alone or an interrupted response without a final answer", () => {
    for (const items of [
      [message("user", "user_message"), message("final")],
      [
        message("user", "user_message"),
        message("step"),
        {
          kind: "thought" as const,
          id: "thought",
          text: "Thinking",
          status: "ready" as const,
          timestamp,
        },
      ],
      [],
    ]) {
      const result = projectResponseFolding({
        items,
        isTurnActive: false,
        activeTurnId: null,
        expandedResponseIds: new Set(),
      });
      expect(result.headersByHostId.size).toBe(0);
      expect(result.hiddenItemIds.size).toBe(0);
    }
  });
  it("keeps every block of the final answer and counts a split intermediate message only once", () => {
    const items: StreamItem[] = [
      message("user", "user_message"),
      { ...message("step-a"), kind: "assistant_message", blockGroupId: "step" },
      { ...message("step-b"), kind: "assistant_message", blockGroupId: "step" },
      { ...message("final-a"), kind: "assistant_message", blockGroupId: "answer" },
      { ...message("final-b"), kind: "assistant_message", blockGroupId: "answer" },
    ];
    const result = projectResponseFolding({
      items,
      isTurnActive: false,
      activeTurnId: null,
      expandedResponseIds: new Set(),
    });
    expect([...result.hiddenItemIds]).toEqual(["step-b"]);
    expect([...result.hiddenMessageResponseIds]).toEqual([["step", "answer"]]);
    const revealed = projectResponseFolding({
      items,
      isTurnActive: false,
      activeTurnId: null,
      expandedResponseIds: new Set(result.hiddenMessageResponseIds.values()),
      previous: result,
    });
    expect(revealed.hiddenMessageResponseIds.size).toBe(0);
    expect(revealed.hiddenItemIds.size).toBe(0);
    expect(result.headersByHostId.get("step-a")).toEqual({
      responseId: "answer",
      count: 1,
      expanded: false,
    });
  });
  it("keeps the prompt, a disclosure host and the final answer, then restores the steps in order", () => {
    const items = [
      message("user", "user_message"),
      message("step-1"),
      message("step-2"),
      message("final"),
    ];
    const collapsed = projectResponseFolding({
      items,
      isTurnActive: false,
      activeTurnId: null,
      expandedResponseIds: new Set(),
    });
    expect(
      items.filter((item) => !collapsed.hiddenItemIds.has(item.id)).map((item) => item.id),
    ).toEqual(["user", "step-1", "final"]);
    expect(collapsed.headersByHostId.get("step-1")).toEqual({
      responseId: "final",
      count: 2,
      expanded: false,
    });
    const expanded = projectResponseFolding({
      items,
      isTurnActive: false,
      activeTurnId: null,
      expandedResponseIds: new Set(["final"]),
    });
    expect(expanded.hiddenItemIds.size).toBe(0);
    expect(expanded.headersByHostId.get("step-1")).toEqual({
      responseId: "final",
      count: 2,
      expanded: true,
    });
  });
});

it("keeps interactive responses visible outside folded tool steps", () => {
  const interactive: StreamItem = {
    kind: "tool_call",
    id: "ui",
    timestamp,
    payload: {
      source: "orchestrator",
      data: {
        toolCallId: "ui",
        toolName: "mcp__paseo__render_interactive_response",
        arguments: {},
        status: "completed",
      },
    },
  };
  const result = projectResponseFolding({
    items: [message("user", "user_message"), message("step"), interactive, message("final")],
    isTurnActive: false,
    activeTurnId: null,
    expandedResponseIds: new Set(),
  });
  expect([...result.hiddenItemIds]).toEqual([]);
  expect(result.headersByHostId.has("ui")).toBe(false);
  expect(result.hiddenMessageResponseIds.has("ui")).toBe(false);
});

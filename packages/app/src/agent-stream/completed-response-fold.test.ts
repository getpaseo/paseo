import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { projectCompletedResponseFolds } from "./completed-response-fold";

function at(second: number): Date {
  return new Date(`2026-01-01T00:00:${second.toString().padStart(2, "0")}.000Z`);
}

function user(id: string, second: number, turnId = id): StreamItem {
  return {
    kind: "user_message",
    id,
    turnId,
    text: id,
    timestamp: at(second),
  };
}

function assistant(id: string, second: number, turnId = id, blockGroupId?: string): StreamItem {
  return {
    kind: "assistant_message",
    id,
    turnId,
    text: id,
    timestamp: at(second),
    ...(blockGroupId ? { blockGroupId } : {}),
  };
}

function thought(id: string, second: number, turnId = id): StreamItem {
  return {
    kind: "thought",
    id,
    turnId,
    text: id,
    timestamp: at(second),
    status: "ready",
  };
}

function tool(
  id: string,
  second: number,
  status: "running" | "completed" | "failed" | "canceled" = "completed",
  turnId = id,
): StreamItem {
  return {
    kind: "tool_call",
    id,
    turnId,
    timestamp: at(second),
    payload: {
      source: "agent",
      data: {
        provider: "codex",
        callId: id,
        name: "shell",
        status,
        error: status === "failed" ? { message: "Synthetic tool failure" } : null,
        detail: { type: "unknown", input: null, output: null },
      },
    },
  };
}

function project(input: {
  tail: StreamItem[];
  head?: StreamItem[];
  isTurnActive?: boolean;
  expandedResponseIds?: ReadonlySet<string>;
  preserveLeadingResponse?: boolean;
}) {
  return projectCompletedResponseFolds({
    tail: input.tail,
    head: input.head ?? [],
    isTurnActive: input.isTurnActive ?? false,
    expandedResponseIds: input.expandedResponseIds ?? new Set(),
    preserveLeadingResponse: input.preserveLeadingResponse ?? false,
  });
}

describe("projectCompletedResponseFolds", () => {
  it("replaces completed response work with one reversible fold anchor", () => {
    const result = project({
      tail: [
        user("user", 1, "turn-1"),
        thought("thought", 2, "turn-1"),
        tool("tool", 3, "completed", "turn-1"),
        assistant("progress", 4, "turn-1"),
        assistant("final", 5, "turn-1"),
      ],
    });

    expect(result.tail.map((item) => item.id)).toEqual(["user", "final"]);
    expect(result.foldsByAnchorItemId.get("final")).toEqual({
      responseId: "final",
      expanded: false,
    });
  });

  it("keeps every block of the final assistant message visible below the fold", () => {
    const result = project({
      tail: [
        user("user", 1, "turn-1"),
        thought("thought", 2, "turn-1"),
        tool("tool", 3, "completed", "turn-1"),
        assistant("final-0", 4, "turn-1", "final"),
        assistant("final-1", 5, "turn-1", "final"),
      ],
    });

    expect(result.tail.map((item) => item.id)).toEqual(["user", "final-0", "final-1"]);
    expect(result.foldsByAnchorItemId.get("final-0")).toEqual({
      responseId: "final-0",
      expanded: false,
    });
    expect(result.foldsByAnchorItemId.has("final-1")).toBe(false);
  });

  it("restores every original item when the response is expanded", () => {
    const tail = [user("user", 1), thought("thought", 2), tool("tool", 3), assistant("final", 4)];

    const result = project({ tail, expandedResponseIds: new Set(["final"]) });

    expect(result.tail).toEqual(tail);
    expect(result.foldsByAnchorItemId.get("final")?.expanded).toBe(true);
  });

  it("never folds the currently active visible response", () => {
    const tail = [user("user", 1), thought("thought", 2), assistant("draft", 3)];

    const result = project({ tail, isTurnActive: true });

    expect(result.tail).toEqual(tail);
    expect(result.foldsByAnchorItemId.size).toBe(0);
  });

  it("keeps the projected history reference stable across live-head updates", () => {
    const tail = [
      user("old-user", 1),
      thought("old-thought", 2),
      assistant("old-final", 3),
      user("active-user", 4),
    ];
    const expandedResponseIds = new Set<string>();

    const first = project({
      tail,
      head: [thought("first-live-thought", 5)],
      isTurnActive: true,
      expandedResponseIds,
    });
    const second = project({
      tail,
      head: [thought("second-live-thought", 6)],
      isTurnActive: true,
      expandedResponseIds,
    });

    expect(first.tail).toBe(second.tail);
    expect(first.tail.map((item) => item.id)).toEqual(["old-user", "old-final", "active-user"]);
    expect(first.foldsByAnchorItemId).toBe(second.foldsByAnchorItemId);
  });

  it("keeps a partial leading response expanded while older history exists", () => {
    const tail = [thought("thought", 1), tool("tool", 2), assistant("final", 3)];

    const result = project({ tail, preserveLeadingResponse: true });

    expect(result.tail).toEqual(tail);
    expect(result.foldsByAnchorItemId.size).toBe(0);
  });

  it("treats hidden system turns as one visible response", () => {
    const result = project({
      tail: [
        user("user", 1, "turn-1"),
        thought("thought", 2, "turn-1"),
        tool("tool", 3, "completed", "turn-2"),
        assistant("final", 4, "turn-2"),
      ],
    });

    expect(result.tail.map((item) => item.id)).toEqual(["user", "final"]);
    expect(result.foldsByAnchorItemId.get("final")?.responseId).toBe("final");
  });

  it("folds a response that spans committed tail and live head lanes", () => {
    const result = project({
      tail: [user("user", 1), thought("thought", 2)],
      head: [tool("tool", 3), assistant("final", 4)],
    });

    expect(result.tail.map((item) => item.id)).toEqual(["user"]);
    expect(result.head.map((item) => item.id)).toEqual(["final"]);
    expect(result.foldsByAnchorItemId.get("final")?.responseId).toBe("final");
  });

  it("keeps response-level errors and still-running tools visible around a collapsed response", () => {
    const error: StreamItem = {
      kind: "activity_log",
      id: "error",
      turnId: "turn-1",
      activityType: "error",
      message: "Provider disconnected",
      timestamp: at(4),
    };
    const result = project({
      tail: [
        user("user", 1, "turn-1"),
        thought("thought", 2, "turn-1"),
        tool("running", 3, "running", "turn-1"),
        error,
        assistant("final", 5, "turn-1"),
      ],
    });

    expect(result.tail.map((item) => item.id)).toEqual(["user", "running", "error", "final"]);
  });

  it("folds failed and canceled tool calls after a settled final answer", () => {
    const result = project({
      tail: [
        user("user", 1, "turn-1"),
        tool("failed", 2, "failed", "turn-1"),
        tool("canceled", 3, "canceled", "turn-1"),
        assistant("final", 4, "turn-1"),
      ],
    });

    expect(result.tail.map((item) => item.id)).toEqual(["user", "final"]);
    expect(result.foldsByAnchorItemId.get("final")?.expanded).toBe(false);
  });

  it("does not fold when work continues after the last assistant message", () => {
    const tail = [user("user", 1), assistant("preamble", 2), tool("tool", 3)];

    const result = project({ tail });

    expect(result.tail).toEqual(tail);
    expect(result.foldsByAnchorItemId.size).toBe(0);
  });

  it("does not fold a response without hidden work", () => {
    const tail = [user("user", 1), assistant("final", 2)];

    const result = project({ tail });

    expect(result.tail).toEqual(tail);
    expect(result.foldsByAnchorItemId.size).toBe(0);
  });

  it("anchors trailing informational activity above the final answer", () => {
    const activity: StreamItem = {
      kind: "activity_log",
      id: "activity",
      activityType: "info",
      message: "Usage updated",
      timestamp: at(3),
    };

    const result = project({
      tail: [user("user", 1), assistant("final", 2), activity],
    });

    expect(result.tail.map((item) => item.id)).toEqual(["user", "final"]);
    expect(result.foldsByAnchorItemId.has("final")).toBe(true);
  });
});

import { describe, expect, test } from "vitest";

import type { MuseViewItem } from "./items.js";
import { mapMuseSubagentEvents } from "./subagents.js";

function subagentItem(overrides: Partial<MuseViewItem> = {}): MuseViewItem {
  return {
    itemId: "sub-1",
    revision: 1,
    kind: "subagent",
    turnId: "turn-1",
    status: "inProgress",
    role: "researcher",
    objective: "Find the bug",
    subagentId: "child-1",
    ...overrides,
  };
}

describe("mapMuseSubagentEvents", () => {
  test("maps running subagents to track upserts", () => {
    expect(mapMuseSubagentEvents(subagentItem(), "muse")).toEqual([
      {
        type: "provider_subagent",
        provider: "muse",
        event: {
          type: "upsert",
          id: "child-1",
          title: "researcher",
          description: "Find the bug",
          status: "running",
        },
      },
    ]);
  });

  test("maps terminal statuses and falls back to the item id", () => {
    const statuses = [
      ["completed", "completed"],
      ["failed", "failed"],
      ["rejected", "failed"],
      ["timedOut", "failed"],
      ["cancelled", "canceled"],
    ] as const;
    for (const [itemStatus, expected] of statuses) {
      const [event] = mapMuseSubagentEvents(
        subagentItem({ status: itemStatus, subagentId: undefined }),
        "muse",
      );
      expect(event).toMatchObject({
        type: "provider_subagent",
        event: { type: "upsert", id: "sub-1", status: expected },
      });
    }
  });

  test("omits status for terminal-unknown values", () => {
    const [event] = mapMuseSubagentEvents(subagentItem({ status: "mystery" }), "muse");
    expect(event).toMatchObject({
      type: "provider_subagent",
      event: { type: "upsert", id: "child-1" },
    });
    expect(event).not.toHaveProperty("event.status");
  });

  test("emits the result row only on terminal frames with a result", () => {
    const completed = subagentItem({
      status: "completed",
      result: { summary: "Found it", text: "The bug is on line 3" },
    });
    expect(mapMuseSubagentEvents(completed, "muse", { terminal: true })).toEqual([
      expect.objectContaining({ type: "provider_subagent" }),
      {
        type: "provider_subagent",
        provider: "muse",
        event: {
          type: "timeline",
          id: "child-1",
          item: {
            type: "assistant_message",
            text: "The bug is on line 3",
            messageId: "sub-1",
          },
        },
      },
    ]);
    // Same item on a non-terminal frame: upsert only, no duplicate row.
    expect(mapMuseSubagentEvents(completed, "muse")).toHaveLength(1);
    expect(
      mapMuseSubagentEvents(subagentItem({ status: "completed" }), "muse", { terminal: true }),
    ).toHaveLength(1);
  });

  test("prefers the summary when result text is absent", () => {
    const [, timeline] = mapMuseSubagentEvents(
      subagentItem({ status: "completed", result: { summary: "Done" } }),
      "muse",
      { terminal: true },
    );
    expect(timeline).toMatchObject({
      event: { type: "timeline", item: { text: "Done" } },
    });
  });

  test("maps reminder children and workflows to track rows", () => {
    const [reminder] = mapMuseSubagentEvents(
      {
        itemId: "rem-1",
        revision: 1,
        kind: "reminderChild",
        status: "inProgress",
        childSessionId: "child-9",
        fallbackText: "Check the build",
        reminderAgentId: "agent-7",
      },
      "muse",
    );
    expect(reminder).toMatchObject({
      event: {
        type: "upsert",
        id: "child-9",
        title: "Check the build",
        description: "agent-7",
        status: "running",
      },
    });

    const [workflow] = mapMuseSubagentEvents(
      {
        itemId: "wf-1",
        revision: 3,
        kind: "workflow",
        status: "completed",
        workflowRunId: "run-1",
        scriptId: "review",
        message: "All checks passed",
      },
      "muse",
    );
    expect(workflow).toMatchObject({
      event: {
        type: "upsert",
        id: "run-1",
        title: "review",
        description: "All checks passed",
        status: "completed",
      },
    });
  });

  test("ignores non-child kinds", () => {
    expect(
      mapMuseSubagentEvents({ ...subagentItem(), kind: "agentMessage" }, "muse"),
    ).toEqual([]);
    expect(mapMuseSubagentEvents({ ...subagentItem(), kind: "toolCall" }, "muse")).toEqual(
      [],
    );
  });
});

import { describe, expect, test } from "vitest";
import { AgentTimeline } from "../timeline/index.js";
import { ProviderSubagentStore } from "./store.js";

describe("ProviderSubagentStore", () => {
  test("keeps provider children and their timelines scoped to the parent agent", async () => {
    const subagents = new ProviderSubagentStore(new AgentTimeline());

    await subagents.apply("parent-a", "codex", {
      type: "upsert",
      id: "child-1",
      title: "Explore",
      cwd: "/workspace/child",
      status: "running",
      timestamp: "2026-07-12T10:00:00.000Z",
    });
    await subagents.apply("parent-a", "codex", {
      type: "timeline",
      id: "child-1",
      item: { type: "assistant_message", text: "Found it." },
      timestamp: "2026-07-12T10:00:01.000Z",
    });
    await subagents.apply("parent-a", "codex", {
      type: "upsert",
      id: "child-1",
      status: "completed",
      timestamp: "2026-07-12T10:00:02.000Z",
    });
    await subagents.apply("parent-b", "claude", {
      type: "upsert",
      id: "child-1",
      title: "Review",
      status: "running",
      timestamp: "2026-07-12T10:00:03.000Z",
    });

    expect(subagents.list("parent-a")).toEqual([
      expect.objectContaining({
        id: "child-1",
        parentAgentId: "parent-a",
        provider: "codex",
        title: "Explore",
        cwd: "/workspace/child",
        status: "completed",
        createdAt: "2026-07-12T10:00:00.000Z",
        updatedAt: "2026-07-12T10:00:02.000Z",
      }),
    ]);
    expect((await subagents.fetchTimeline("parent-a", "child-1")).rows).toMatchObject([
      {
        seq: 1,
        timestamp: "2026-07-12T10:00:01.000Z",
        item: { type: "assistant_message", text: "Found it." },
      },
    ]);
    expect(subagents.list("parent-b")[0]).toMatchObject({ provider: "claude", title: "Review" });
    expect(await subagents.deleteParent("parent-a")).toEqual([
      { type: "remove", parentAgentId: "parent-a", subagentId: "child-1" },
    ]);
    expect(subagents.list("parent-a")).toEqual([]);
    expect(subagents.list("parent-b")).toHaveLength(1);
  });

  test("limits oversized provider child tool output before storage", async () => {
    const subagents = new ProviderSubagentStore(new AgentTimeline());
    const output = "x".repeat(70 * 1024);
    const update = await subagents.apply("parent-a", "opencode", {
      type: "timeline",
      id: "child-1",
      item: {
        type: "tool_call",
        callId: "call-1",
        name: "shell",
        status: "completed",
        error: null,
        detail: { type: "shell", command: "print", output },
      },
    });

    expect(update?.type).toBe("timeline");
    const [row] = (await subagents.fetchTimeline("parent-a", "child-1")).rows;
    expect(row?.item).toMatchObject({
      type: "tool_call",
      detail: { type: "shell", output: expect.stringMatching(/^x+…\[truncated \d+\.\d KB\]$/) },
    });
  });

  test("retires the children of rewound tool calls and drops their late events", async () => {
    const subagents = new ProviderSubagentStore(new AgentTimeline());
    const upsert = (id: string, fields: { toolCallId?: string; parentSubagentId?: string }) =>
      subagents.apply("parent-a", "claude", {
        type: "upsert",
        id,
        status: "running",
        timestamp: "2026-07-12T10:00:00.000Z",
        ...fields,
      });
    await upsert("kept", { toolCallId: "call-a" });
    await upsert("rewound", { toolCallId: "call-b" });
    await upsert("grandchild", { parentSubagentId: "rewound" });
    await subagents.apply("parent-a", "claude", {
      type: "timeline",
      id: "rewound",
      item: { type: "assistant_message", text: "Working on B." },
    });

    expect(subagents.retireSpawnedBy("parent-a", new Set(["call-b"]))).toEqual([
      { type: "remove", parentAgentId: "parent-a", subagentId: "rewound" },
      { type: "remove", parentAgentId: "parent-a", subagentId: "grandchild" },
    ]);
    expect(subagents.list("parent-a").map((subagent) => subagent.id)).toEqual(["kept"]);

    // The retired child's history stays stored; a late event neither revives nor extends it.
    expect(
      await subagents.apply("parent-a", "claude", {
        type: "timeline",
        id: "rewound",
        item: { type: "assistant_message", text: "Late output." },
      }),
    ).toBeNull();
    expect(await upsert("rewound", { toolCallId: "call-b" })).toBeNull();
    expect(subagents.list("parent-a").map((subagent) => subagent.id)).toEqual(["kept"]);
    expect(
      (await subagents.fetchTimeline("parent-a", "rewound")).rows.map((row) => row.item),
    ).toEqual([{ type: "assistant_message", text: "Working on B." }]);
  });

  test("pages provider history on projected item boundaries", async () => {
    const subagents = new ProviderSubagentStore(new AgentTimeline());
    for (let index = 0; index < 101; index += 1) {
      await subagents.apply("parent-a", "opencode", {
        type: "timeline",
        id: "child-1",
        item: { type: "assistant_message", text: String(index) },
      });
    }

    const page = await subagents.fetchTimeline("parent-a", "child-1", {
      direction: "tail",
      limit: 1,
    });
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]?.seqStart).toBe(1);
    expect(page.rows[0]?.item).toMatchObject({
      text: Array.from({ length: 101 }, (_, i) => String(i)).join(""),
    });
    expect(page.rows.at(-1)?.seq).toBe(101);
    expect(page.hasOlder).toBe(false);
  });
});

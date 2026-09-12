import { describe, expect, it, vi } from "vitest";
import {
  buildTranscriptSnapshot,
  createAgentTranscriptSearch,
  MAX_TRANSCRIPT_BYTES,
  type AgentContextSearchDependencies,
} from "./server/agent-context";

function entry(
  id: string,
  options: {
    title?: string;
    updatedAt?: string;
    archivedAt?: string;
    parentAgentId?: string;
    projectName?: string;
    workspaceName?: string;
  } = {},
) {
  const labels: Record<string, string> = {};
  if (options.parentAgentId) {
    labels["paseo.parent-agent-id"] = options.parentAgentId;
  }
  return {
    agent: {
      id,
      title: options.title ?? `Agent ${id}`,
      provider: "codex",
      cwd: `/work/${id}`,
      updatedAt: options.updatedAt ?? "2026-09-10T10:00:00.000Z",
      ...(options.archivedAt ? { archivedAt: options.archivedAt } : {}),
      labels,
    },
    project: {
      projectName: options.projectName ?? "Paseo",
      workspaceName: options.workspaceName ?? "main",
    },
  };
}

function dependencies(input: {
  entries: ReturnType<typeof entry>[];
  timeline?: unknown[];
  fetchTimeline?: AgentContextSearchDependencies["fetchTimeline"];
}): AgentContextSearchDependencies {
  return {
    listAgents: vi.fn(async () => ({
      entries: input.entries,
      pageInfo: { nextCursor: null },
    })),
    fetchTimeline:
      input.fetchTimeline ??
      vi.fn(async () => ({
        epoch: "epoch-1",
        staleCursor: false,
        hasOlder: false,
        startCursor: null,
        entries: (input.timeline ?? []).map((item) => ({ item })),
        error: null,
      })),
    now: () => new Date("2026-09-10T12:00:00.000Z"),
  };
}

describe("agent transcript attachment source", () => {
  it("searches top-level agents and returns a privacy-curated snapshot", async () => {
    const source = dependencies({
      entries: [
        entry("unrelated", { title: "Documentation" }),
        entry("child", { title: "Checkout child", parentAgentId: "parent" }),
        entry("archived", {
          title: "Checkout archive",
          archivedAt: "2026-09-09T00:00:00.000Z",
        }),
        entry("source-agent", { title: "Checkout review", workspaceName: "payments" }),
      ],
      timeline: [
        { type: "user_message", text: "Review checkout." },
        { type: "reasoning", text: "private reasoning" },
        {
          type: "tool_call",
          name: "provider_secret_tool_name",
          detail: { type: "shell", command: "printenv SECRET", output: "token-value" },
        },
        {
          type: "tool_call",
          name: "Task",
          detail: { type: "sub_agent", log: "private child log" },
        },
        { type: "assistant_message", text: "The checkout is ready." },
      ],
    });

    const result = await createAgentTranscriptSearch(source)({ query: "checkout" });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: "source-agent",
      identifier: "source-a",
      title: "Checkout review",
      subtitle: "payments · Paseo · codex",
      resourceType: "agent transcript",
    });
    expect(result.items[0]?.text).toContain("Captured: 2026-09-10T12:00:00.000Z");
    expect(result.items[0]?.text).toContain("[User] Review checkout.");
    expect(result.items[0]?.text).toContain("[Tool: Shell]");
    expect(result.items[0]?.text).toContain("[Tool: Subagent]");
    expect(result.items[0]?.text).toContain("[Assistant] The checkout is ready.");
    expect(result.items[0]?.text).not.toContain("private reasoning");
    expect(result.items[0]?.text).not.toContain("provider_secret_tool_name");
    expect(result.items[0]?.text).not.toContain("printenv SECRET");
    expect(result.items[0]?.text).not.toContain("token-value");
    expect(result.items[0]?.text).not.toContain("private child log");
    expect(source.fetchTimeline).toHaveBeenCalledTimes(1);
    expect(source.fetchTimeline).toHaveBeenCalledWith("source-agent", {
      direction: "tail",
      limit: 200,
      projection: "projected",
    });
  });

  it("pages backward to build one chronological snapshot", async () => {
    const fetchTimeline = vi
      .fn<AgentContextSearchDependencies["fetchTimeline"]>()
      .mockResolvedValueOnce({
        epoch: "epoch-1",
        staleCursor: false,
        hasOlder: true,
        startCursor: { epoch: "epoch-1", seq: 20 },
        entries: [{ item: { type: "assistant_message", text: "Newer answer." } }],
        error: null,
      })
      .mockResolvedValueOnce({
        epoch: "epoch-1",
        staleCursor: false,
        hasOlder: false,
        startCursor: { epoch: "epoch-1", seq: 1 },
        entries: [{ item: { type: "user_message", text: "Older question." } }],
        error: null,
      });
    const source = dependencies({ entries: [entry("agent-1")], fetchTimeline });

    const result = await createAgentTranscriptSearch(source)({ query: "agent" });

    const text = result.items[0]?.text ?? "";
    expect(text.indexOf("[User] Older question.")).toBeLessThan(
      text.indexOf("[Assistant] Newer answer."),
    );
    expect(fetchTimeline).toHaveBeenNthCalledWith(2, "agent-1", {
      direction: "before",
      cursor: { epoch: "epoch-1", seq: 20 },
      limit: 200,
      projection: "projected",
    });
  });

  it("continues directory search across pages before snapshotting matches", async () => {
    const source = dependencies({ entries: [] });
    source.listAgents = vi
      .fn<AgentContextSearchDependencies["listAgents"]>()
      .mockResolvedValueOnce({
        entries: [entry("first", { title: "Unrelated" })],
        pageInfo: { nextCursor: "next-page" },
      })
      .mockResolvedValueOnce({
        entries: [entry("second", { title: "Payments handoff" })],
        pageInfo: { nextCursor: null },
      });

    const result = await createAgentTranscriptSearch(source)({ query: "payments" });

    expect(result.items.map((item) => item.id)).toEqual(["second"]);
    expect(source.listAgents).toHaveBeenNthCalledWith(2, {
      sort: [{ key: "updated_at", direction: "desc" }],
      page: { limit: 200, cursor: "next-page" },
    });
    expect(source.fetchTimeline).toHaveBeenCalledTimes(1);
    expect(source.fetchTimeline).toHaveBeenCalledWith("second", expect.any(Object));
  });

  it("bounds snapshots to the five best search results", async () => {
    const source = dependencies({
      entries: Array.from({ length: 7 }, (_, index) => entry(`agent-${index}`)),
    });

    const result = await createAgentTranscriptSearch(source)({ query: "agent" });

    expect(result.items.map((item) => item.id)).toEqual([
      "agent-0",
      "agent-1",
      "agent-2",
      "agent-3",
      "agent-4",
    ]);
    expect(source.fetchTimeline).toHaveBeenCalledTimes(5);
  });

  it("keeps a UTF-8-safe recent suffix within the snapshot byte limit", () => {
    const snapshot = buildTranscriptSnapshot({
      metadata: {
        agent: entry("agent-1").agent,
        project: entry("agent-1").project,
        capturedAt: new Date("2026-09-10T12:00:00.000Z"),
      },
      items: [
        { type: "user_message", text: "old context" },
        { type: "assistant_message", text: "😀".repeat(MAX_TRANSCRIPT_BYTES) },
      ],
    });

    expect(new TextEncoder().encode(snapshot).byteLength).toBeLessThanOrEqual(MAX_TRANSCRIPT_BYTES);
    expect(snapshot).toContain("Earlier context was omitted");
    expect(snapshot).toContain("[Earlier content in this message omitted]");
    expect(snapshot).not.toContain("�");
    expect(snapshot).toMatch(/<\/chat-history-summary>$/);
  });

  it("bounds timeline paging when projected pages contain no shareable rows", async () => {
    let sequence = 1_000;
    const fetchTimeline = vi.fn<AgentContextSearchDependencies["fetchTimeline"]>(async () => ({
      epoch: "epoch-1",
      staleCursor: false,
      hasOlder: true,
      startCursor: { epoch: "epoch-1", seq: sequence-- },
      entries: [],
      error: null,
    }));
    const source = dependencies({ entries: [entry("agent-1")], fetchTimeline });

    const result = await createAgentTranscriptSearch(source)({ query: "agent" });

    expect(fetchTimeline).toHaveBeenCalledTimes(25);
    expect(result.items[0]?.text).toContain(
      "Earlier context was omitted to fit the snapshot size limit.",
    );
  });

  it("keeps successful snapshots when another source disappears", async () => {
    const source = dependencies({
      entries: [entry("available"), entry("missing")],
      fetchTimeline: vi.fn(async (agentId) => {
        if (agentId === "missing") throw new Error("Agent not found");
        return {
          epoch: "epoch-1",
          staleCursor: false,
          hasOlder: false,
          startCursor: null,
          entries: [{ item: { type: "assistant_message", text: "Available." } }],
          error: null,
        };
      }),
    });

    const result = await createAgentTranscriptSearch(source)({ query: "agent" });

    expect(result.items.map((item) => item.id)).toEqual(["available"]);
  });

  it("surfaces an error when every matching snapshot fails", async () => {
    const source = dependencies({
      entries: [entry("missing")],
      fetchTimeline: vi.fn(async () => {
        throw new Error("Agent not found");
      }),
    });

    await expect(createAgentTranscriptSearch(source)({ query: "missing" })).rejects.toThrow(
      "Agent not found",
    );
  });

  it("does not read agent history before the user enters a search", async () => {
    const source = dependencies({ entries: [entry("agent-1")] });

    await expect(createAgentTranscriptSearch(source)({ query: "  " })).resolves.toEqual({
      items: [],
    });
    expect(source.listAgents).not.toHaveBeenCalled();
    expect(source.fetchTimeline).not.toHaveBeenCalled();
  });
});

import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { describe, expect, it, vi } from "vitest";
import contribute from "./index.server";
import { searchAgentTranscriptsRpc } from "./shared/agent-context";

const MAX_EXPECTED_TRANSCRIPT_BYTES = 128 * 1024;
interface TimelinePage {
  epoch: string;
  staleCursor: boolean;
  hasOlder: boolean;
  startCursor: { epoch: string; seq: number } | null;
  entries: Array<{ item: unknown }>;
  error: string | null;
}
interface SearchContext {
  paseo: {
    agents: {
      list(options: {
        sort: Array<{ key: "updated_at"; direction: "desc" }>;
        page: { limit: number; cursor?: string };
      }): Promise<{
        entries: Array<ReturnType<typeof entry>>;
        pageInfo: { nextCursor: string | null };
      }>;
      ref(agentId: string): {
        timeline: {
          refetch(options: {
            direction: "tail" | "before";
            cursor?: { epoch: string; seq: number };
            limit: number;
            projection: "projected";
          }): Promise<TimelinePage>;
        };
      };
    };
  };
}
type ListAgents = SearchContext["paseo"]["agents"]["list"];
type TimelineRefetch = ReturnType<SearchContext["paseo"]["agents"]["ref"]>["timeline"]["refetch"];
type FetchTimeline = (
  agentId: string,
  options: Parameters<TimelineRefetch>[0],
) => Promise<TimelinePage>;
type SearchHandler = (
  input: RpcInput<typeof searchAgentTranscriptsRpc>,
  context: SearchContext,
) =>
  | RpcOutput<typeof searchAgentTranscriptsRpc>
  | Promise<RpcOutput<typeof searchAgentTranscriptsRpc>>;

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
  listAgents?: ListAgents;
  fetchTimeline?: FetchTimeline;
}) {
  const listAgents =
    input.listAgents ??
    vi.fn<ListAgents>(async () => ({
      entries: input.entries,
      pageInfo: { nextCursor: null },
    }));
  const fetchTimeline =
    input.fetchTimeline ??
    vi.fn<FetchTimeline>(async () => ({
      epoch: "epoch-1",
      staleCursor: false,
      hasOlder: false,
      startCursor: null,
      entries: (input.timeline ?? []).map((item) => ({ item })),
      error: null,
    }));
  return {
    context: {
      paseo: {
        agents: {
          list: listAgents,
          ref: (agentId: string) => ({
            timeline: {
              refetch: (options: Parameters<TimelineRefetch>[0]) => fetchTimeline(agentId, options),
            },
          }),
        },
      },
    },
    listAgents,
    fetchTimeline,
  };
}

function registeredSearchHandler(): SearchHandler {
  let search: SearchHandler | undefined;
  contribute({
    handle(contract, handler) {
      expect(contract).toBe(searchAgentTranscriptsRpc);
      search = handler as unknown as SearchHandler;
    },
  } as PluginServerContext);
  if (!search) throw new Error("Agent transcript search handler was not registered");
  return search;
}

const searchAgentTranscripts = registeredSearchHandler();

async function invokeSearch(source: ReturnType<typeof dependencies>, query: string) {
  const input = searchAgentTranscriptsRpc.input.parse({ query });
  const output = await searchAgentTranscripts(input, source.context);
  return searchAgentTranscriptsRpc.output.parse(output);
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

    const result = await invokeSearch(source, "checkout");

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: "source-agent",
      identifier: "source-a",
      title: "Checkout review",
      subtitle: "payments · Paseo · codex",
      resourceType: "agent transcript",
      contextKind: "chat_history",
    });
    expect(result.items[0]?.text).toMatch(/Captured: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
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
      .fn<FetchTimeline>()
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

    const result = await invokeSearch(source, "agent");

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
    const listAgents = vi
      .fn<ListAgents>()
      .mockResolvedValueOnce({
        entries: [entry("first", { title: "Unrelated" })],
        pageInfo: { nextCursor: "next-page" },
      })
      .mockResolvedValueOnce({
        entries: [entry("second", { title: "Payments handoff" })],
        pageInfo: { nextCursor: null },
      });
    const source = dependencies({ entries: [], listAgents });

    const result = await invokeSearch(source, "payments");

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

    const result = await invokeSearch(source, "agent");

    expect(result.items.map((item) => item.id)).toEqual([
      "agent-0",
      "agent-1",
      "agent-2",
      "agent-3",
      "agent-4",
    ]);
    expect(source.fetchTimeline).toHaveBeenCalledTimes(5);
  });

  it("keeps a UTF-8-safe recent suffix within the snapshot byte limit", async () => {
    const source = dependencies({
      entries: [entry("agent-1")],
      timeline: [
        { type: "user_message", text: "old context" },
        { type: "assistant_message", text: "😀".repeat(MAX_EXPECTED_TRANSCRIPT_BYTES) },
      ],
    });
    const result = await invokeSearch(source, "agent-1");
    const snapshot = result.items[0]?.text ?? "";

    expect(new TextEncoder().encode(snapshot).byteLength).toBeLessThanOrEqual(
      MAX_EXPECTED_TRANSCRIPT_BYTES,
    );
    expect(snapshot).toContain("Earlier context was omitted");
    expect(snapshot).toContain("[Earlier content in this message omitted]");
    expect(snapshot).not.toContain("�");
    expect(snapshot).toMatch(/<\/chat-history-summary>$/);
  });

  it("bounds timeline paging when projected pages contain no shareable rows", async () => {
    let sequence = 1_000;
    const fetchTimeline = vi.fn<FetchTimeline>(async () => ({
      epoch: "epoch-1",
      staleCursor: false,
      hasOlder: true,
      startCursor: { epoch: "epoch-1", seq: sequence-- },
      entries: [],
      error: null,
    }));
    const source = dependencies({ entries: [entry("agent-1")], fetchTimeline });

    const result = await invokeSearch(source, "agent");

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

    const result = await invokeSearch(source, "agent");

    expect(result.items.map((item) => item.id)).toEqual(["available"]);
  });

  it("surfaces an error when every matching snapshot fails", async () => {
    const source = dependencies({
      entries: [entry("missing")],
      fetchTimeline: vi.fn(async () => {
        throw new Error("Agent not found");
      }),
    });

    await expect(invokeSearch(source, "missing")).rejects.toThrow("Agent not found");
  });

  it("does not read agent history before the user enters a search", async () => {
    const source = dependencies({ entries: [entry("agent-1")] });

    await expect(invokeSearch(source, "  ")).resolves.toEqual({
      items: [],
    });
    expect(source.listAgents).not.toHaveBeenCalled();
    expect(source.fetchTimeline).not.toHaveBeenCalled();
  });
});

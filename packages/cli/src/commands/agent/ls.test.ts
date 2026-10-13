import { describe, expect, it, vi } from "vitest";
import { buildAgentLsFetchOptions, runLsCommand } from "./ls.js";

describe("buildAgentLsFetchOptions", () => {
  it("fetches active agents by default", () => {
    expect(buildAgentLsFetchOptions({})).toEqual({
      scope: "active",
    });
  });

  it("keeps label and thinking filters within the active scope", () => {
    expect(
      buildAgentLsFetchOptions({
        label: ["surface=workspace"],
        thinking: " medium ",
      }),
    ).toEqual({
      scope: "active",
      filter: {
        labels: { surface: "workspace" },
        thinkingOptionId: "medium",
      },
    });
  });

  it("asks the daemon for internal agents only with --internal", () => {
    expect(buildAgentLsFetchOptions({ background: true, global: true })).toEqual({
      filter: { includeBackground: true },
    });
  });

  it("fetches global non-archived agents for -g", () => {
    expect(buildAgentLsFetchOptions({ global: true })).toEqual({});
  });

  it("includes archived and background agents with -a", () => {
    expect(buildAgentLsFetchOptions({ all: true })).toEqual({
      filter: {
        includeArchived: true,
        includeBackground: true,
      },
    });
  });

  it("fetches all global agents for -a -g", () => {
    expect(buildAgentLsFetchOptions({ all: true, global: true })).toEqual({
      filter: {
        includeArchived: true,
        includeBackground: true,
      },
    });
  });

  it("applies filters to global queries", () => {
    expect(
      buildAgentLsFetchOptions({
        global: true,
        label: ["surface=workspace"],
        thinking: " medium ",
      }),
    ).toEqual({
      filter: {
        labels: { surface: "workspace" },
        thinkingOptionId: "medium",
      },
    });
  });
});

const daemonTarget = { kind: "endpoint" as const, host: "example.test:12345" };

// Each fetchAgents call returns one page of 2 agents. Two pages => 4 agents total.
// This reproduces getpaseo/paseo#6031 where the previous implementation stopped
// after the first page and silently dropped every agent beyond pageInfo.hasMore.
const fetchAgents = vi.fn(async (options?: { page?: { cursor?: string } }) => {
  const start = Number(options?.page?.cursor ?? 0);
  const end = start + 2;
  const entries = [];
  for (let i = start; i < end; i += 1) {
    entries.push({
      agent: {
        id: `agent-${i}`,
        status: i === 0 ? "running" : "idle",
        archivedAt: null,
        cwd: "/tmp/project",
        createdAt: new Date(1700000000000 + i * 1000).toISOString(),
        provider: "test-provider",
        title: `Agent ${i}`,
      },
    });
  }
  return {
    entries,
    pageInfo: {
      nextCursor: end < 4 ? String(end) : null,
      prevCursor: null,
      hasMore: end < 4,
    },
  };
});

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(async () => ({
    fetchAgents,
    close: vi.fn(async () => undefined),
  })),
}));

describe("runLsCommand pagination", () => {
  it("returns every agent across pages, not just the first page", async () => {
    const result = await runLsCommand({ daemonTarget }, {} as never);

    expect(fetchAgents).toHaveBeenCalledTimes(2);
    expect(result.data).toHaveLength(4);
    // Order is determined by the existing status/createdAt sort; we only
    // care that every page was surfaced (the bug dropped agent-2 and
    // agent-3 because they were past page 1).
    expect(new Set(result.data.map((d) => d.id))).toEqual(
      new Set(["agent-0", "agent-1", "agent-2", "agent-3"]),
    );
  });

  it("does not pass a cursor on the first request", async () => {
    fetchAgents.mockClear();
    await runLsCommand({ daemonTarget }, {} as never);
    const firstCall = fetchAgents.mock.calls[0][0];
    expect(firstCall.page?.cursor).toBeUndefined();
  });

  it("passes the previous page's nextCursor to the next request", async () => {
    fetchAgents.mockClear();
    await runLsCommand({ daemonTarget }, {} as never);
    const secondCall = fetchAgents.mock.calls[1][0];
    expect(secondCall.page?.cursor).toBe("2");
  });

  it("stops when pageInfo.hasMore is false", async () => {
    fetchAgents.mockClear();
    fetchAgents.mockImplementationOnce(async () => ({
      entries: [
        {
          agent: {
            id: "only-agent",
            status: "running",
            archivedAt: null,
            cwd: "/tmp/project",
            createdAt: new Date(1700000000000).toISOString(),
            provider: "test-provider",
            title: "Only",
          },
        },
      ],
      pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
    }));
    const result = await runLsCommand({ daemonTarget }, {} as never);
    expect(fetchAgents).toHaveBeenCalledTimes(1);
    expect(result.data).toHaveLength(1);
  });
});

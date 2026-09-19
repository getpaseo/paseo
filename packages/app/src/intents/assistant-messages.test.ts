import { describe, expect, it } from "vitest";
import type { Agent } from "@/stores/session-store";
import {
  buildAssistantMessageRows,
  mergeAssistantMessageRows,
  type AssistantMessageAgent,
  type AssistantTimelineEntry,
} from "./assistant-messages";
import {
  parseAssistantQueryRequest,
  resolveAssistantQueryTargets,
  runAssistantQuery,
  type AssistantQueryHost,
} from "./assistant-query";

const target: AssistantMessageAgent = {
  serverId: "laptop",
  agentId: "a-1",
  agentName: "Sidebar crash",
  workspaceId: "ws-1",
};

function entry(
  item: AssistantTimelineEntry["item"],
  timestamp: string,
  seqEnd = 1,
): AssistantTimelineEntry {
  return { item, timestamp, seqEnd };
}

function agent(overrides: Partial<Agent> & Pick<Agent, "id" | "lastActivityAt">): Agent {
  return {
    serverId: "laptop",
    provider: "claude",
    status: "idle",
    turn: "idle",
    createdAt: new Date(0),
    updatedAt: overrides.lastActivityAt,
    lastUserMessageAt: null,
    capabilities: {} as Agent["capabilities"],
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: null,
    cwd: "/home/me/paseo",
    model: null,
    parentAgentId: null,
    labels: {},
    ...overrides,
  } as Agent;
}

function host(overrides: Partial<AssistantQueryHost> & Pick<AssistantQueryHost, "serverId">) {
  return {
    label: overrides.serverId,
    connected: true,
    workspaceIds: new Set<string>(),
    agents: [],
    ...overrides,
  } satisfies AssistantQueryHost;
}

describe("buildAssistantMessageRows", () => {
  it("keeps prompts, replies, and tool summaries newest first and drops the rest", () => {
    const rows = buildAssistantMessageRows(
      target,
      [
        entry(
          { type: "user_message", text: "fix the crash", messageId: "u-1" },
          "2026-09-14T10:00:00Z",
          1,
        ),
        entry({ type: "reasoning", text: "thinking" }, "2026-09-14T10:00:01Z", 2),
        entry(
          {
            type: "tool_call",
            callId: "call-1",
            name: "read_file",
            status: "completed",
            error: null,
            detail: { type: "read", filePath: "/home/me/paseo/sidebar.tsx" },
          },
          "2026-09-14T10:00:02Z",
          3,
        ),
        entry(
          { type: "todo", items: [{ text: "ship", completed: false }] },
          "2026-09-14T10:00:03Z",
          4,
        ),
        entry(
          { type: "assistant_message", text: "  Fixed it.  ", messageId: "m-1" },
          "2026-09-14T10:00:04Z",
          5,
        ),
      ],
      10,
    );

    expect(rows.map((row) => [row.kind, row.id])).toEqual([
      ["assistant", "m-1"],
      ["tool", "call-1"],
      ["user", "u-1"],
    ]);
    expect(rows[0].text).toBe("Fixed it.");
    expect(rows[1].text).toBe("Read: /home/me/paseo/sidebar.tsx");
    expect(rows[0].createdAt).toBe("2026-09-14T10:00:04.000Z");
    expect(rows[0].agentName).toBe("Sidebar crash");
    expect(rows[0].workspaceId).toBe("ws-1");
  });

  it("clips long text with an ellipsis and stops at the limit", () => {
    const rows = buildAssistantMessageRows(
      target,
      [
        entry({ type: "assistant_message", text: "old" }, "2026-09-14T10:00:00Z", 1),
        entry({ type: "assistant_message", text: "x".repeat(2000) }, "2026-09-14T10:00:01Z", 2),
      ],
      1,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].text).toHaveLength(1000);
    expect(rows[0].text.endsWith("…")).toBe(true);
    expect(rows[0].id).toBe("seq:2");
  });

  it("returns no createdAt when the entry timestamp is not a date", () => {
    const rows = buildAssistantMessageRows(
      target,
      [entry({ type: "user_message", text: "hi" }, "")],
      10,
    );
    expect(rows[0].createdAt).toBeNull();
  });
});

describe("mergeAssistantMessageRows", () => {
  it("interleaves agents by time and keeps the newest rows", () => {
    const first = buildAssistantMessageRows(
      { ...target, agentId: "a-1", agentName: "first" },
      [
        entry({ type: "assistant_message", text: "first old" }, "2026-09-14T10:00:00Z", 1),
        entry({ type: "assistant_message", text: "first new" }, "2026-09-14T10:00:30Z", 2),
      ],
      10,
    );
    const second = buildAssistantMessageRows(
      { ...target, agentId: "a-2", agentName: "second" },
      [entry({ type: "assistant_message", text: "second middle" }, "2026-09-14T10:00:10Z", 1)],
      10,
    );

    expect(mergeAssistantMessageRows([first, second], 2).map((row) => row.text)).toEqual([
      "first new",
      "second middle",
    ]);
  });
});

describe("parseAssistantQueryRequest", () => {
  it("defaults the limit and lets agentId win over workspaceId", () => {
    expect(
      parseAssistantQueryRequest({ requestId: "r-1", agentId: "a-1", workspaceId: "ws-1" }),
    ).toEqual({ requestId: "r-1", agentId: "a-1", workspaceId: null, limit: 10 });
  });

  it("drops a request without a target or with a bad limit", () => {
    expect(parseAssistantQueryRequest({ requestId: "r-1" })).toBeNull();
    expect(parseAssistantQueryRequest({ requestId: "r-1", agentId: "a-1", limit: 500 })).toBeNull();
  });
});

describe("resolveAssistantQueryTargets", () => {
  const request = { requestId: "r-1", agentId: null, workspaceId: "ws-1", limit: 10 };

  it("fans out over a workspace's top-level agents, newest first", () => {
    const resolved = resolveAssistantQueryTargets(request, [
      host({
        serverId: "laptop",
        workspaceIds: new Set(["ws-1"]),
        agents: [
          agent({
            id: "a-old",
            workspaceId: "ws-1",
            lastActivityAt: new Date("2026-09-14T09:00:00Z"),
          }),
          agent({
            id: "a-new",
            workspaceId: "ws-1",
            lastActivityAt: new Date("2026-09-14T10:00:00Z"),
          }),
          agent({
            id: "a-child",
            workspaceId: "ws-1",
            parentAgentId: "a-new",
            lastActivityAt: new Date("2026-09-14T10:00:00Z"),
          }),
          agent({
            id: "a-archived",
            workspaceId: "ws-1",
            archivedAt: new Date("2026-09-14T10:00:00Z"),
            lastActivityAt: new Date("2026-09-14T10:00:00Z"),
          }),
          agent({
            id: "a-other",
            workspaceId: "ws-2",
            lastActivityAt: new Date("2026-09-14T11:00:00Z"),
          }),
        ],
      }),
    ]);

    expect(resolved.notice).toBeNull();
    expect(resolved.targets.map((found) => found.agentId)).toEqual(["a-new", "a-old"]);
  });

  it("notices an unknown workspace and an offline host", () => {
    expect(resolveAssistantQueryTargets(request, []).notice).toContain(
      "does not know that workspace",
    );
    expect(
      resolveAssistantQueryTargets(request, [
        host({
          serverId: "laptop",
          label: "Laptop",
          connected: false,
          workspaceIds: new Set(["ws-1"]),
        }),
      ]).notice,
    ).toContain("Laptop is offline");
  });

  it("notices an unknown agent", () => {
    expect(
      resolveAssistantQueryTargets({ ...request, agentId: "a-gone", workspaceId: null }, []).notice,
    ).toContain("does not know that agent");
  });
});

describe("runAssistantQuery", () => {
  const request = { requestId: "r-1", agentId: "a-1", workspaceId: null, limit: 10 };
  const hosts = [
    host({
      serverId: "laptop",
      workspaceIds: new Set(["ws-1"]),
      agents: [
        agent({ id: "a-1", workspaceId: "ws-1", lastActivityAt: new Date("2026-09-14T10:00:00Z") }),
      ],
    }),
  ];

  it("answers with a single notice row when nothing is listening for the agent", async () => {
    const rows = await runAssistantQuery({
      request,
      hosts: [],
      fetchEntries: async () => {
        throw new Error("must not fetch");
      },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("notice");
    expect(rows[0].agentId).toBe("a-1");
    expect(rows[0].createdAt).toBeNull();
  });

  it("answers with a notice row when the fetch fails", async () => {
    const rows = await runAssistantQuery({
      request,
      hosts,
      fetchEntries: async () => {
        throw new Error("offline");
      },
    });

    expect(rows.map((row) => row.kind)).toEqual(["notice"]);
    expect(rows[0].text).toContain("could not read");
  });

  it("returns the agent's rows when the fetch succeeds", async () => {
    const rows = await runAssistantQuery({
      request,
      hosts,
      fetchEntries: async () => [
        entry({ type: "assistant_message", text: "working on it" }, "2026-09-14T10:00:00Z"),
      ],
    });

    expect(rows.map((row) => [row.kind, row.text])).toEqual([["assistant", "working on it"]]);
    expect(rows[0].agentName).toBe("paseo");
  });

  it("returns no rows when the workspace has no agents to read", async () => {
    const rows = await runAssistantQuery({
      request: { requestId: "r-1", agentId: null, workspaceId: "ws-1", limit: 10 },
      hosts: [host({ serverId: "laptop", workspaceIds: new Set(["ws-1"]) })],
      fetchEntries: async () => {
        throw new Error("must not fetch");
      },
    });

    expect(rows).toEqual([]);
  });
});

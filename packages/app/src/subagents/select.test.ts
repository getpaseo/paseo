import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentSubsessionPayload } from "@getpaseo/protocol/messages";
import { afterEach, describe, expect, it } from "vitest";
import {
  selectSubagentsForParent,
  selectSubsessionsForAgent,
  selectWorkspaceSubsessionAgents,
} from "./select";
import { useSessionStore, type Agent } from "@/stores/session-store";

const SERVER_ID = "server-1";
const AGENT_TIMESTAMP = new Date("2026-03-08T10:00:00.000Z");
const EMPTY_PENDING_ARCHIVE_IDS = new Set<string>();

const AGENT_DEFAULTS: Agent = {
  serverId: SERVER_ID,
  id: "agent",
  provider: "codex",
  status: "idle",
  createdAt: AGENT_TIMESTAMP,
  updatedAt: AGENT_TIMESTAMP,
  lastUserMessageAt: null,
  lastActivityAt: AGENT_TIMESTAMP,
  capabilities: {
    supportsStreaming: true,
    supportsSessionPersistence: true,
    supportsDynamicModes: true,
    supportsMcpServers: true,
    supportsReasoningStream: true,
    supportsToolInvocations: true,
  },
  currentModeId: null,
  availableModes: [],
  pendingPermissions: [],
  persistence: null,
  runtimeInfo: undefined,
  lastUsage: undefined,
  lastError: null,
  title: "Agent",
  cwd: "/tmp/project",
  model: null,
  features: undefined,
  thinkingOptionId: undefined,
  requiresAttention: false,
  attentionReason: null,
  attentionTimestamp: null,
  archivedAt: null,
  parentAgentId: null,
  labels: {},
  projectPlacement: null,
};

function makeAgent(input: Partial<Agent> & Pick<Agent, "id">): Agent {
  return { ...AGENT_DEFAULTS, ...input };
}

function setAgents(agents: Agent[]): void {
  useSessionStore.getState().initializeSession(SERVER_ID, null as unknown as DaemonClient);
  useSessionStore
    .getState()
    .setAgents(SERVER_ID, new Map(agents.map((agent) => [agent.id, agent])));
}

afterEach(() => {
  useSessionStore.getState().clearSession(SERVER_ID);
});

describe("selectSubagentsForParent", () => {
  it("returns only non-archived children for the requested parent", () => {
    setAgents([
      makeAgent({ id: "parent-a" }),
      makeAgent({ id: "child-a", parentAgentId: "parent-a" }),
      makeAgent({
        id: "archived-child",
        parentAgentId: "parent-a",
        archivedAt: new Date("2026-03-08T12:00:00.000Z"),
      }),
    ]);

    const rows = selectSubagentsForParent(
      useSessionStore.getState(),
      {
        serverId: SERVER_ID,
        parentAgentId: "parent-a",
      },
      EMPTY_PENDING_ARCHIVE_IDS,
    );

    expect(rows.map((row) => row.id)).toEqual(["child-a"]);
  });

  it("excludes siblings, unrelated agents, and grandchildren", () => {
    setAgents([
      makeAgent({ id: "parent-a" }),
      makeAgent({ id: "parent-b" }),
      makeAgent({ id: "child-a", parentAgentId: "parent-a" }),
      makeAgent({ id: "sibling-b", parentAgentId: "parent-b" }),
      makeAgent({ id: "grandchild-a", parentAgentId: "child-a" }),
      makeAgent({ id: "unrelated" }),
    ]);

    const rows = selectSubagentsForParent(
      useSessionStore.getState(),
      {
        serverId: SERVER_ID,
        parentAgentId: "parent-a",
      },
      EMPTY_PENDING_ARCHIVE_IDS,
    );

    expect(rows.map((row) => row.id)).toEqual(["child-a"]);
  });

  it("shows only direct children for each parent", () => {
    setAgents([
      makeAgent({ id: "parent" }),
      makeAgent({ id: "child", parentAgentId: "parent" }),
      makeAgent({ id: "grandchild", parentAgentId: "child" }),
    ]);

    const parentRows = selectSubagentsForParent(
      useSessionStore.getState(),
      {
        serverId: SERVER_ID,
        parentAgentId: "parent",
      },
      EMPTY_PENDING_ARCHIVE_IDS,
    );
    const childRows = selectSubagentsForParent(
      useSessionStore.getState(),
      {
        serverId: SERVER_ID,
        parentAgentId: "child",
      },
      EMPTY_PENDING_ARCHIVE_IDS,
    );

    expect(parentRows.map((row) => row.id)).toEqual(["child"]);
    expect(childRows.map((row) => row.id)).toEqual(["grandchild"]);
  });

  it("sorts by createdAt ascending", () => {
    setAgents([
      makeAgent({ id: "parent" }),
      makeAgent({
        id: "third",
        parentAgentId: "parent",
        createdAt: new Date("2026-03-08T10:03:00.000Z"),
      }),
      makeAgent({
        id: "first",
        parentAgentId: "parent",
        createdAt: new Date("2026-03-08T10:01:00.000Z"),
      }),
      makeAgent({
        id: "second",
        parentAgentId: "parent",
        createdAt: new Date("2026-03-08T10:02:00.000Z"),
      }),
    ]);

    const rows = selectSubagentsForParent(
      useSessionStore.getState(),
      {
        serverId: SERVER_ID,
        parentAgentId: "parent",
      },
      EMPTY_PENDING_ARCHIVE_IDS,
    );

    expect(rows.map((row) => row.id)).toEqual(["first", "second", "third"]);
  });

  it("maps only row-rendered fields and does not expose onOpen", () => {
    const createdAt = new Date("2026-03-08T10:01:00.000Z");
    setAgents([
      makeAgent({ id: "parent" }),
      makeAgent({
        id: "child",
        parentAgentId: "parent",
        provider: "claude",
        title: "Review child",
        status: "running",
        requiresAttention: true,
        createdAt,
        model: "should-not-leak",
        cwd: "/private/project",
      }),
    ]);

    const rows = selectSubagentsForParent(
      useSessionStore.getState(),
      {
        serverId: SERVER_ID,
        parentAgentId: "parent",
      },
      EMPTY_PENDING_ARCHIVE_IDS,
    );

    expect(rows).toEqual([
      {
        id: "child",
        provider: "claude",
        title: "Review child",
        status: "running",
        requiresAttention: true,
        createdAt,
      },
    ]);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
      "createdAt",
      "id",
      "provider",
      "requiresAttention",
      "status",
      "title",
    ]);
    expect(rows[0]).not.toHaveProperty("onOpen");
    expect(rows[0]).not.toHaveProperty("model");
    expect(rows[0]).not.toHaveProperty("cwd");
  });

  it("moves a child when parentAgentId changes", () => {
    const child = makeAgent({ id: "child", parentAgentId: "parent-a" });
    setAgents([makeAgent({ id: "parent-a" }), makeAgent({ id: "parent-b" }), child]);

    expect(
      selectSubagentsForParent(
        useSessionStore.getState(),
        {
          serverId: SERVER_ID,
          parentAgentId: "parent-a",
        },
        EMPTY_PENDING_ARCHIVE_IDS,
      ).map((row) => row.id),
    ).toEqual(["child"]);
    expect(
      selectSubagentsForParent(
        useSessionStore.getState(),
        {
          serverId: SERVER_ID,
          parentAgentId: "parent-b",
        },
        EMPTY_PENDING_ARCHIVE_IDS,
      ).map((row) => row.id),
    ).toEqual([]);

    setAgents([
      makeAgent({ id: "parent-a" }),
      makeAgent({ id: "parent-b" }),
      { ...child, parentAgentId: "parent-b" },
    ]);

    expect(
      selectSubagentsForParent(
        useSessionStore.getState(),
        {
          serverId: SERVER_ID,
          parentAgentId: "parent-a",
        },
        EMPTY_PENDING_ARCHIVE_IDS,
      ).map((row) => row.id),
    ).toEqual([]);
    expect(
      selectSubagentsForParent(
        useSessionStore.getState(),
        {
          serverId: SERVER_ID,
          parentAgentId: "parent-b",
        },
        EMPTY_PENDING_ARCHIVE_IDS,
      ).map((row) => row.id),
    ).toEqual(["child"]);
  });

  it("excludes children whose archive is pending", () => {
    setAgents([
      makeAgent({ id: "parent" }),
      makeAgent({ id: "child-a", parentAgentId: "parent" }),
      makeAgent({ id: "child-b", parentAgentId: "parent" }),
    ]);

    const rows = selectSubagentsForParent(
      useSessionStore.getState(),
      {
        serverId: SERVER_ID,
        parentAgentId: "parent",
      },
      new Set(["child-b"]),
    );

    expect(rows.map((row) => row.id)).toEqual(["child-a"]);
  });

  it("returns the shared empty array when pending archive hides the last child", () => {
    setAgents([makeAgent({ id: "parent" }), makeAgent({ id: "child", parentAgentId: "parent" })]);

    const rows = selectSubagentsForParent(
      useSessionStore.getState(),
      {
        serverId: SERVER_ID,
        parentAgentId: "parent",
      },
      new Set(["child"]),
    );

    expect(rows).toEqual([]);
    expect(rows).toBe(
      selectSubagentsForParent(
        useSessionStore.getState(),
        {
          serverId: SERVER_ID,
          parentAgentId: "missing-parent",
        },
        EMPTY_PENDING_ARCHIVE_IDS,
      ),
    );
  });
});

function makeSubsession(
  id: string,
  status: AgentSubsessionPayload["status"] = "idle",
): AgentSubsessionPayload {
  return { id, title: `Sub ${id}`, status, parentSessionId: null };
}

describe("selectSubsessionsForAgent", () => {
  it("returns the agent's subsessions from the agents map", () => {
    const subsessions = [makeSubsession("s1"), makeSubsession("s2", "running")];
    setAgents([makeAgent({ id: "agent-a", subsessions })]);

    expect(
      selectSubsessionsForAgent(useSessionStore.getState(), {
        serverId: SERVER_ID,
        agentId: "agent-a",
      }),
    ).toEqual(subsessions);
  });

  it("falls back to agentDetails when the agent is not in the list map", () => {
    const subsessions = [makeSubsession("s1")];
    useSessionStore.getState().initializeSession(SERVER_ID, null as unknown as DaemonClient);
    useSessionStore
      .getState()
      .setAgentDetails(
        SERVER_ID,
        new Map([["agent-a", makeAgent({ id: "agent-a", subsessions })]]),
      );

    expect(
      selectSubsessionsForAgent(useSessionStore.getState(), {
        serverId: SERVER_ID,
        agentId: "agent-a",
      }),
    ).toEqual(subsessions);
  });

  it("returns the shared empty array when the agent has no subsessions", () => {
    setAgents([makeAgent({ id: "agent-a" })]);

    const withoutSubsessions = selectSubsessionsForAgent(useSessionStore.getState(), {
      serverId: SERVER_ID,
      agentId: "agent-a",
    });
    const missingAgent = selectSubsessionsForAgent(useSessionStore.getState(), {
      serverId: SERVER_ID,
      agentId: "missing",
    });

    expect(withoutSubsessions).toEqual([]);
    expect(withoutSubsessions).toBe(missingAgent);
  });
});

describe("selectWorkspaceSubsessionAgents", () => {
  it("returns only workspace agents that have subsessions, sorted by createdAt", () => {
    const subsA = [makeSubsession("a1")];
    const subsB = [makeSubsession("b1", "running"), makeSubsession("b2")];
    setAgents([
      makeAgent({
        id: "late",
        workspaceId: "ws-1",
        subsessions: subsA,
        createdAt: new Date("2026-03-08T11:00:00.000Z"),
      }),
      makeAgent({
        id: "early",
        workspaceId: "ws-1",
        subsessions: subsB,
        createdAt: new Date("2026-03-08T09:00:00.000Z"),
      }),
      makeAgent({ id: "no-subs", workspaceId: "ws-1" }),
      makeAgent({ id: "other-ws", workspaceId: "ws-2", subsessions: subsA }),
      makeAgent({
        id: "archived",
        workspaceId: "ws-1",
        subsessions: subsA,
        archivedAt: new Date("2026-03-08T12:00:00.000Z"),
      }),
    ]);

    expect(
      selectWorkspaceSubsessionAgents(useSessionStore.getState(), {
        serverId: SERVER_ID,
        workspaceId: "ws-1",
      }),
    ).toEqual([
      { agentId: "early", subsessions: subsB },
      { agentId: "late", subsessions: subsA },
    ]);
  });

  it("returns the shared empty array when nothing matches", () => {
    setAgents([makeAgent({ id: "agent-a", workspaceId: "ws-1" })]);

    const noSubsessions = selectWorkspaceSubsessionAgents(useSessionStore.getState(), {
      serverId: SERVER_ID,
      workspaceId: "ws-1",
    });
    const missingServer = selectWorkspaceSubsessionAgents(useSessionStore.getState(), {
      serverId: "missing",
      workspaceId: "ws-1",
    });

    expect(noSubsessions).toEqual([]);
    expect(noSubsessions).toBe(missingServer);
  });
});

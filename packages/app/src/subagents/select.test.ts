import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSubagentsForParentSelector,
  selectProviderSubagentsForParent,
  selectSubagentsForParent,
} from "./select";
import { createWorkspaceAgentVisibilitySelector } from "@/workspace-tabs/agent-visibility";
import { useProviderSubagentStore } from "./provider-store";
import { useSessionStore, type Agent } from "@/stores/session-store";

const SERVER_ID = "server-1";
const AGENT_TIMESTAMP = new Date("2026-03-08T10:00:00.000Z");
const EMPTY_PENDING_ARCHIVE_IDS = new Set<string>();

const AGENT_DEFAULTS: Agent = {
  serverId: SERVER_ID,
  id: "agent",
  provider: "codex",
  status: "idle",
  turn: { phase: "idle", cancellationRequestId: null },
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
  return {
    ...AGENT_DEFAULTS,
    ...input,
    labels: {
      ...(input.parentAgentId ? { "paseo.parent-agent-id": input.parentAgentId } : {}),
      ...input.labels,
    },
  };
}

function setAgents(agents: Agent[]): void {
  useSessionStore.getState().initializeSession(SERVER_ID, null as unknown as DaemonClient);
  useSessionStore
    .getState()
    .setAgents(SERVER_ID, new Map(agents.map((agent) => [agent.id, agent])));
}

afterEach(() => {
  useSessionStore.getState().clearSession(SERVER_ID);
  useProviderSubagentStore.setState({
    descriptors: new Map(),
    timelines: new Map(),
    hiddenFromTrack: new Set(),
  });
});

describe("selectSubagentsForParent", () => {
  it("keeps equal child IDs on different hosts qualified to the complete parent address", () => {
    const parentId = "shared-parent";
    const childId = "shared-child";
    const local = makeAgent({
      id: childId,
      parentAgentId: parentId,
      labels: { "paseo.parent-agent-id": parentId, "paseo.parent-server-id": SERVER_ID },
    });
    const remote = makeAgent({
      id: childId,
      serverId: "server-2",
      parentAgentId: null,
      labels: { "paseo.parent-agent-id": parentId, "paseo.parent-server-id": SERVER_ID },
    });
    setAgents([local]);
    useSessionStore.getState().initializeSession("server-2", null as unknown as DaemonClient);
    useSessionStore.getState().setAgents("server-2", new Map([[childId, remote]]));
    try {
      const rows = selectSubagentsForParent(
        useSessionStore.getState(),
        { serverId: SERVER_ID, parentAgentId: parentId },
        EMPTY_PENDING_ARCHIVE_IDS,
      );
      expect(rows).toHaveLength(2);
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ address: { serverId: SERVER_ID, agentId: childId } }),
          expect.objectContaining({ address: { serverId: "server-2", agentId: childId } }),
        ]),
      );
    } finally {
      useSessionStore.getState().clearSession("server-2");
    }
  });

  it("hides cached provider children when the host does not support them", () => {
    useProviderSubagentStore.getState().applyUpdate(SERVER_ID, {
      kind: "upsert",
      subagent: {
        id: "provider-child",
        parentAgentId: "parent-a",
        provider: "codex",
        title: "Provider child",
        description: null,
        subtitle: "Codex worker · 4.2k tokens",
        status: "completed",
        createdAt: "2026-03-08T10:01:00.000Z",
        updatedAt: "2026-03-08T10:02:00.000Z",
        toolCallId: "call-1",
      },
    });
    const params = { serverId: SERVER_ID, parentAgentId: "parent-a" };

    expect(
      selectProviderSubagentsForParent(useProviderSubagentStore.getState(), params, false),
    ).toEqual([]);
    expect(
      selectProviderSubagentsForParent(useProviderSubagentStore.getState(), params, true).map(
        (row) => row.id,
      ),
    ).toEqual(["provider-child"]);
    expect(
      selectProviderSubagentsForParent(useProviderSubagentStore.getState(), params, true)[0]
        ?.subtitle,
    ).toBe("Codex worker · 4.2k tokens");
  });

  it("hides locally dismissed provider children while retaining their descriptor", () => {
    const store = useProviderSubagentStore.getState();
    store.applyUpdate(SERVER_ID, {
      kind: "upsert",
      subagent: {
        id: "provider-child",
        parentAgentId: "parent-a",
        provider: "codex",
        title: "Provider child",
        description: null,
        status: "completed",
        createdAt: "2026-03-08T10:01:00.000Z",
        updatedAt: "2026-03-08T10:02:00.000Z",
        toolCallId: "call-1",
      },
    });
    store.hideFromTrack(SERVER_ID, "parent-a", ["provider-child"]);

    expect(
      selectProviderSubagentsForParent(
        useProviderSubagentStore.getState(),
        { serverId: SERVER_ID, parentAgentId: "parent-a" },
        true,
      ),
    ).toEqual([]);
    expect(useProviderSubagentStore.getState().descriptors.size).toBe(1);
  });

  it("places nested provider children only beneath their direct provider parent", () => {
    const store = useProviderSubagentStore.getState();
    const base = {
      parentAgentId: "parent-a",
      provider: "claude" as const,
      title: "general-purpose",
      subtitle: null,
      status: "running" as const,
      createdAt: "2026-09-04T10:00:00.000Z",
      updatedAt: "2026-09-04T10:00:00.000Z",
      toolCallId: null,
    };
    store.applyUpdate(SERVER_ID, {
      kind: "upsert",
      subagent: { ...base, id: "direct", description: "Direct", parentSubagentId: null },
    });
    store.applyUpdate(SERVER_ID, {
      kind: "upsert",
      subagent: {
        ...base,
        id: "nested",
        description: "Nested",
        parentSubagentId: "direct",
      },
    });

    expect(
      selectProviderSubagentsForParent(
        useProviderSubagentStore.getState(),
        { serverId: SERVER_ID, parentAgentId: "parent-a" },
        true,
        true,
      ).map((row) => row.id),
    ).toEqual(["direct"]);
    expect(
      selectProviderSubagentsForParent(
        useProviderSubagentStore.getState(),
        {
          serverId: SERVER_ID,
          parentAgentId: "parent-a",
          providerParentSubagentId: "direct",
        },
        true,
        true,
      ).map((row) => row.id),
    ).toEqual(["nested"]);
  });

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
        kind: "paseo",
        address: { serverId: SERVER_ID, agentId: "child" },
        id: "child",
        provider: "claude",
        title: "Review child",
        description: null,
        subtitle: null,
        status: "running",
        turn: { phase: "idle", cancellationRequestId: null },
        requiresAttention: true,
        createdAt,
      },
    ]);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
      "address",
      "createdAt",
      "description",
      "id",
      "kind",
      "provider",
      "requiresAttention",
      "status",
      "subtitle",
      "title",
      "turn",
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
      { ...child, parentAgentId: "parent-b", labels: { "paseo.parent-agent-id": "parent-b" } },
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
      new Set([`${SERVER_ID}:child-b`]),
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
      new Set([`${SERVER_ID}:child`]),
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

describe("createSubagentsForParentSelector", () => {
  class IterationCountingMap<K, V> extends Map<K, V> {
    iterations = 0;
    override values() {
      this.iterations += 1;
      return super.values();
    }
    override entries() {
      this.iterations += 1;
      return super.entries();
    }
    override [Symbol.iterator]() {
      this.iterations += 1;
      return super[Symbol.iterator]();
    }
  }

  const params = { serverId: SERVER_ID, parentAgentId: "parent" };

  function streamTick(text: string): void {
    useSessionStore.getState().setAgentStreamState(SERVER_ID, "parent", {
      head: [
        {
          kind: "assistant_message",
          id: "message-1",
          text,
          timestamp: new Date("2026-03-08T10:05:00.000Z"),
        },
      ],
    });
  }

  it("returns the cached rows without walking agents when a stream tick leaves them unchanged", () => {
    const agents = new IterationCountingMap<string, Agent>(
      [
        makeAgent({ id: "parent" }),
        makeAgent({ id: "child", parentAgentId: "parent" }),
        makeAgent({ id: "unrelated" }),
      ].map((agent) => [agent.id, agent]),
    );
    useSessionStore.getState().initializeSession(SERVER_ID, null as unknown as DaemonClient);
    useSessionStore.getState().setAgents(SERVER_ID, agents);
    const select = createSubagentsForParentSelector(params, EMPTY_PENDING_ARCHIVE_IDS);
    const before = select(useSessionStore.getState());
    const iterationsAfterFirstSelect = agents.iterations;

    for (let tick = 0; tick < 100; tick += 1) {
      streamTick(`token ${tick}`);
      expect(select(useSessionStore.getState())).toBe(before);
    }

    expect(useSessionStore.getState().sessions[SERVER_ID]?.agents).toBe(agents);
    expect(agents.iterations).toBe(iterationsAfterFirstSelect);
    expect(before.map((row) => row.id)).toEqual(["child"]);
  });

  it("recomputes when the agents map changes", () => {
    setAgents([makeAgent({ id: "parent" }), makeAgent({ id: "child-a", parentAgentId: "parent" })]);
    const select = createSubagentsForParentSelector(params, EMPTY_PENDING_ARCHIVE_IDS);
    const before = select(useSessionStore.getState());

    useSessionStore.getState().setAgents(SERVER_ID, (current) => {
      const child = makeAgent({
        id: "child-b",
        parentAgentId: "parent",
        createdAt: new Date("2026-03-08T10:01:00.000Z"),
      });
      return new Map(current).set(child.id, child);
    });
    const after = select(useSessionStore.getState());

    expect(after).not.toBe(before);
    expect(after.map((row) => row.id)).toEqual(["child-a", "child-b"]);
  });

  it("keeps the previous rows when a changed agents map yields the same rows", () => {
    setAgents([
      makeAgent({ id: "parent" }),
      makeAgent({ id: "child", parentAgentId: "parent" }),
      makeAgent({ id: "unrelated" }),
    ]);
    const select = createSubagentsForParentSelector(params, EMPTY_PENDING_ARCHIVE_IDS);
    const before = select(useSessionStore.getState());

    useSessionStore.getState().setAgents(SERVER_ID, (current) => {
      return new Map(current).set("unrelated", makeAgent({ id: "unrelated", status: "running" }));
    });

    expect(select(useSessionStore.getState())).toBe(before);
  });

  it("applies the pending archive ids it was created with", () => {
    setAgents([
      makeAgent({ id: "parent" }),
      makeAgent({ id: "child-a", parentAgentId: "parent" }),
      makeAgent({ id: "child-b", parentAgentId: "parent" }),
    ]);

    const rows = createSubagentsForParentSelector(
      params,
      new Set([`${SERVER_ID}:child-b`]),
    )(useSessionStore.getState());

    expect(rows.map((row) => row.id)).toEqual(["child-a"]);
  });
  it("does no agent map walks for 100 stream commits with unchanged source maps", () => {
    const agents = new IterationCountingMap<string, Agent>(
      Array.from({ length: 200 }, (_, i) => {
        const agent = makeAgent({
          id: `agent-${i}`,
          workspaceId: "workspace",
          parentAgentId: i < 3 ? null : `agent-${i % 3}`,
        });
        return [agent.id, agent] as const;
      }),
    );
    useSessionStore.getState().initializeSession(SERVER_ID, null as unknown as DaemonClient);
    useSessionStore.getState().setAgents(SERVER_ID, agents);
    const selectVisibility = createWorkspaceAgentVisibilitySelector({
      serverId: SERVER_ID,
      workspaceId: "workspace",
    });
    const selectChildren = Array.from({ length: 3 }, (_, i) =>
      createSubagentsForParentSelector(
        { serverId: SERVER_ID, parentAgentId: `agent-${i}` },
        EMPTY_PENDING_ARCHIVE_IDS,
      ),
    );
    const select = (state: ReturnType<typeof useSessionStore.getState>) => {
      selectVisibility(state);
      selectChildren.forEach((selector) => selector(state));
    };
    select(useSessionStore.getState());
    const before = agents.iterations;
    const unsubscribe = useSessionStore.subscribe(select);
    try {
      for (let tick = 0; tick < 100; tick++) {
        useSessionStore.getState().setAgentStreamState(SERVER_ID, "agent-0", {
          head: [
            {
              kind: "assistant_message",
              id: "message",
              text: `token ${tick}`,
              timestamp: AGENT_TIMESTAMP,
            },
          ],
        });
      }
      expect(useSessionStore.getState().sessions[SERVER_ID]?.agents).toBe(agents);
      expect(agents.iterations - before).toBe(0);
    } finally {
      unsubscribe();
      useSessionStore.getState().clearSession(SERVER_ID);
    }
  });
});

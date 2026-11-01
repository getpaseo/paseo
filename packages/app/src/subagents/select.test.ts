import { hydrateArchiveFinishedActivity } from "./use-archive-finished";
import { DaemonConnectionError } from "@getpaseo/client/internal/daemon-client";
import { getParentAddressFromLabels } from "@getpaseo/protocol/agent-labels";
import { createArchiveFinishedSubagents } from "./archive-finished";
import type { AgentAddress } from "@getpaseo/protocol/addresses";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSubagentsForParentSelector,
  createProviderSubagentsForParentSelector,
  hydrateSubagentActivity,
  selectProviderSubagentsForParent,
  selectSubagentsForParent,
} from "./select";
import { buildSubagentRowPresentationData, countFinishedSubagents } from "./track-presentation";
import { createWorkspaceAgentVisibilitySelector } from "@/workspace-tabs/agent-visibility";
import {
  hydrateProviderSubagents,
  resyncProviderSubagents,
  useProviderSubagentStore,
} from "./provider-store";
import {
  getSubagentActivity,
  managedActivityKey,
  managedSubtreeAddresses,
  providerSubagentKey,
} from "./activity";
import type { ProviderSubagentDescriptorPayload } from "@getpaseo/protocol/messages";
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

function setAgents(agents: Agent[], serverId = SERVER_ID): void {
  useSessionStore.getState().initializeSession(serverId, null as unknown as DaemonClient);
  useSessionStore.getState().updateSessionServerInfo(serverId, {
    serverId,
    hostname: null,
    version: null,
    features: { providerSubagents: true, providerSubagentNesting: true },
  });
  useSessionStore.getState().setAgents(serverId, new Map(agents.map((agent) => [agent.id, agent])));
}

afterEach(() => {
  useSessionStore.getState().clearSession(SERVER_ID);
  useSessionStore.getState().clearSession("server-2");
  useSessionStore.getState().clearSession("server-3");
  useProviderSubagentStore.setState({
    descriptors: new Map(),
    timelines: new Map(),
    hiddenFromTrack: new Set(),
    trackedParents: new Set(),
  });
});

describe("selectSubagentsForParent", () => {
  it("keeps an idle child working while a managed grandchild runs, without changing lifecycle", () => {
    const child = makeAgent({ id: "child", parentAgentId: "parent" });
    setAgents([
      makeAgent({ id: "parent" }),
      child,
      makeAgent({
        id: "grandchild",
        parentAgentId: "child",
        status: "running",
        turn: { phase: "open", turnId: null, startedAt: null, cancellationRequestId: null },
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
    expect(buildSubagentRowPresentationData(rows[0]!).statusBucket).toBe("running");
    expect(countFinishedSubagents(rows)).toBe(0);
    expect(rows[0]?.status).toBe("idle");
    expect(child.turn.phase).toBe("idle");
  });

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
        hasActiveDescendants: false,
        requiresAttention: true,
        createdAt,
      },
    ]);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
      "address",
      "createdAt",
      "description",
      "hasActiveDescendants",
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

function native(
  overrides: Partial<ProviderSubagentDescriptorPayload> &
    Pick<ProviderSubagentDescriptorPayload, "id">,
): ProviderSubagentDescriptorPayload {
  return {
    parentAgentId: "child",
    provider: "claude",
    title: "Explore",
    description: null,
    status: "completed",
    createdAt: AGENT_TIMESTAMP.toISOString(),
    updatedAt: AGENT_TIMESTAMP.toISOString(),
    toolCallId: null,
    ...overrides,
  };
}

function activity(pendingArchiveKeys: ReadonlySet<string> = EMPTY_PENDING_ARCHIVE_IDS) {
  return getSubagentActivity({
    sessions: useSessionStore.getState().sessions,
    descriptors: useProviderSubagentStore.getState().descriptors,
    hiddenFromTrack: useProviderSubagentStore.getState().hiddenFromTrack,
    pendingArchiveKeys,
  });
}

function mixedRows() {
  return selectSubagentsForParent(
    useSessionStore.getState(),
    {
      serverId: SERVER_ID,
      parentAgentId: "parent",
    },
    EMPTY_PENDING_ARCHIVE_IDS,
    activity(),
  );
}

describe("descendant activity", () => {
  it("protects an idle ancestor while a managed grandchild initializes, then clears activity", () => {
    const parent = makeAgent({ id: "parent" });
    const child = makeAgent({ id: "child", parentAgentId: "parent" });
    const grandchild = makeAgent({
      id: "grandchild",
      parentAgentId: "child",
      status: "initializing",
    });
    setAgents([parent, child, grandchild]);
    expect(buildSubagentRowPresentationData(mixedRows()[0]!).statusBucket).toBe("running");
    expect(countFinishedSubagents(mixedRows())).toBe(0);
    expect(grandchild.turn.phase).toBe("idle");
    expect(child.status).toBe("idle");
    setAgents([parent, child, { ...grandchild, status: "idle" }]);
    expect(countFinishedSubagents(mixedRows())).toBe(1);
    expect(activity().managed.size).toBe(0);
  });

  it("propagates nested native work through managed ancestors and clears it on completion", () => {
    setAgents([
      makeAgent({ id: "parent" }),
      makeAgent({ id: "child", parentAgentId: "parent" }),
      makeAgent({ id: "grandchild", parentAgentId: "child" }),
    ]);
    const store = useProviderSubagentStore.getState();
    store.replaceList(SERVER_ID, "grandchild", [
      native({ id: "native-parent", parentAgentId: "grandchild" }),
      native({
        id: "native-middle",
        parentAgentId: "grandchild",
        parentSubagentId: "native-parent",
      }),
      native({
        id: "native-leaf",
        parentAgentId: "grandchild",
        parentSubagentId: "native-middle",
        status: "running",
      }),
    ]);
    expect([...activity().managed].sort()).toEqual(
      ["child", "grandchild", "parent"].map((agentId) =>
        managedActivityKey({ serverId: SERVER_ID, agentId }),
      ),
    );
    expect(buildSubagentRowPresentationData(mixedRows()[0]!).statusBucket).toBe("running");
    expect(countFinishedSubagents(mixedRows())).toBe(0);
    const providerRows = selectProviderSubagentsForParent(
      useProviderSubagentStore.getState(),
      {
        serverId: SERVER_ID,
        parentAgentId: "grandchild",
      },
      true,
      true,
      activity(),
    );
    expect(providerRows).toHaveLength(1);
    expect(providerRows[0]?.status).toBe("completed");
    expect(buildSubagentRowPresentationData(providerRows[0]!).statusBucket).toBe("running");
    expect(countFinishedSubagents(providerRows)).toBe(0);
    store.applyUpdate(SERVER_ID, {
      kind: "upsert",
      subagent: native({
        id: "native-leaf",
        parentAgentId: "grandchild",
        parentSubagentId: "native-middle",
        status: "completed",
      }),
    });
    expect(activity().managed.size).toBe(0);
    expect(activity().provider.size).toBe(0);
    expect(buildSubagentRowPresentationData(mixedRows()[0]!).statusBucket).toBe("done");
    expect(countFinishedSubagents(mixedRows())).toBe(1);
    expect(useSessionStore.getState().sessions[SERVER_ID]?.agents.get("child")?.status).toBe(
      "idle",
    );
  });

  it("stops at archived, pending archive, detached, hidden, and server boundaries", () => {
    const grandchild = makeAgent({ id: "grandchild", parentAgentId: "child" });
    setAgents([
      makeAgent({ id: "parent" }),
      makeAgent({ id: "child", parentAgentId: "parent" }),
      grandchild,
    ]);
    const descriptor = native({ id: "native", parentAgentId: "grandchild", status: "running" });
    const store = useProviderSubagentStore.getState();
    store.replaceList("other-server", "grandchild", [descriptor]);
    expect(activity().managed.size).toBe(0);
    store.replaceList(SERVER_ID, "grandchild", [descriptor]);
    expect(
      activity().managed.has(managedActivityKey({ serverId: SERVER_ID, agentId: "child" })),
    ).toBe(true);
    expect(
      activity(new Set([`${SERVER_ID}:grandchild`])).managed.has(
        managedActivityKey({ serverId: SERVER_ID, agentId: "child" }),
      ),
    ).toBe(false);
    setAgents([
      makeAgent({ id: "parent" }),
      makeAgent({ id: "child", parentAgentId: "parent" }),
      { ...grandchild, archivedAt: AGENT_TIMESTAMP },
    ]);
    expect(
      activity().managed.has(managedActivityKey({ serverId: SERVER_ID, agentId: "child" })),
    ).toBe(false);
    setAgents([
      makeAgent({ id: "parent" }),
      makeAgent({ id: "child", parentAgentId: "parent" }),
      { ...grandchild, parentAgentId: null, labels: {} },
    ]);
    expect(
      activity().managed.has(managedActivityKey({ serverId: SERVER_ID, agentId: "child" })),
    ).toBe(false);
    setAgents([
      makeAgent({ id: "parent" }),
      makeAgent({ id: "child", parentAgentId: "parent" }),
      grandchild,
    ]);
    useProviderSubagentStore.setState({
      hiddenFromTrack: new Set([providerSubagentKey(SERVER_ID, "grandchild", "native")]),
    });
    expect(
      activity().managed.has(managedActivityKey({ serverId: SERVER_ID, agentId: "child" })),
    ).toBe(false);
  });

  it("cold-loads unopened managed descendants once and resyncs their native lists", async () => {
    setAgents([
      makeAgent({ id: "parent" }),
      makeAgent({ id: "child", parentAgentId: "parent" }),
      makeAgent({ id: "grandchild", parentAgentId: "child" }),
    ]);
    const calls: string[] = [];
    let status: ProviderSubagentDescriptorPayload["status"] = "running";
    const client = {
      async listProviderSubagents(parentAgentId: string) {
        calls.push(parentAgentId);
        return {
          requestId: "list",
          error: null,
          parentAgentId,
          subagents:
            parentAgentId === "grandchild" ? [native({ id: "native", parentAgentId, status })] : [],
        };
      },
    };
    const ids = managedSubtreeAddresses(activity(), { serverId: SERVER_ID, agentId: "parent" }).map(
      (address) => address.agentId,
    );
    await hydrateProviderSubagents(client, SERVER_ID, ids);
    expect(calls).toEqual(["parent", "child", "grandchild"]);
    expect(buildSubagentRowPresentationData(mixedRows()[0]!).statusBucket).toBe("running");
    await hydrateProviderSubagents(client, SERVER_ID, ids);
    expect(calls).toHaveLength(3);
    status = "completed";
    await resyncProviderSubagents(client, SERVER_ID);
    expect(calls).toEqual([...ids, ...ids]);
    expect(countFinishedSubagents(mixedRows())).toBe(1);
    setAgents([
      makeAgent({ id: "parent" }),
      makeAgent({ id: "child", parentAgentId: "parent" }),
      makeAgent({ id: "grandchild", parentAgentId: "child" }),
      makeAgent({ id: "new-child", parentAgentId: "child" }),
    ]);
    await hydrateProviderSubagents(
      client,
      SERVER_ID,
      managedSubtreeAddresses(activity(), { serverId: SERVER_ID, agentId: "parent" }).map(
        (address) => address.agentId,
      ),
    );
    expect(calls.at(-1)).toBe("new-child");
    expect(calls).toHaveLength(7);
  });

  it("reuses the activity index for equivalent pending sets and invalidates same-size changes", () => {
    setAgents([
      makeAgent({ id: "parent" }),
      makeAgent({ id: "child", parentAgentId: "parent", status: "initializing" }),
    ]);
    const empty = activity(new Set());
    expect(activity(new Set())).toBe(empty);
    const pending = activity(new Set([`${SERVER_ID}:child`]));
    expect(pending).not.toBe(empty);
    expect(pending.managed.size).toBe(0);
    expect(activity(new Set([`${SERVER_ID}:child`]))).toBe(pending);
    const other = activity(new Set([`${SERVER_ID}:other`]));
    expect(other).not.toBe(pending);
    expect(other.managed.has(managedActivityKey({ serverId: SERVER_ID, agentId: "parent" }))).toBe(
      true,
    );
  });

  it("reuses the activity index and provider rows on timeline-only updates", () => {
    setAgents([makeAgent({ id: "parent" }), makeAgent({ id: "child", parentAgentId: "parent" })]);
    const store = useProviderSubagentStore.getState();
    store.replaceList(SERVER_ID, "child", [native({ id: "native", status: "running" })]);
    const before = activity();
    const select = createProviderSubagentsForParentSelector(
      { serverId: SERVER_ID, parentAgentId: "child" },
      true,
      true,
      before,
    );
    const rows = select(useProviderSubagentStore.getState());
    for (let seq = 1; seq <= 100; seq++) {
      store.applyUpdate(SERVER_ID, {
        kind: "timeline",
        parentAgentId: "child",
        subagentId: "native",
        provider: "claude",
        epoch: "epoch",
        seq,
        timestamp: AGENT_TIMESTAMP.toISOString(),
        item: { type: "assistant_message", text: `token ${seq}` },
      });
      expect(activity()).toBe(before);
      expect(select(useProviderSubagentStore.getState())).toBe(rows);
    }
  });
});

describe("cross-host descendant activity", () => {
  function seedCrossHostTree() {
    const localChild = makeAgent({ id: "child", parentAgentId: "parent" });
    const remoteChild = makeAgent({
      id: "child",
      serverId: "server-2",
      parentAgentId: null,
      labels: { "paseo.parent-agent-id": "parent", "paseo.parent-server-id": SERVER_ID },
    });
    const grandchild = makeAgent({
      id: "grandchild",
      serverId: "server-3",
      parentAgentId: null,
      labels: { "paseo.parent-agent-id": "child", "paseo.parent-server-id": "server-2" },
    });
    setAgents([makeAgent({ id: "parent" }), localChild]);
    setAgents([remoteChild], "server-2");
    setAgents([grandchild], "server-3");
    return { localChild, remoteChild, grandchild };
  }

  it("qualifies managed and native descendants, including equal agent IDs on different hosts", () => {
    const { grandchild } = seedCrossHostTree();
    setAgents(
      [
        {
          ...grandchild,
          status: "running",
          turn: {
            phase: "open",
            turnId: null,
            startedAt: null,
            cancellationRequestId: null,
          },
        },
      ],
      "server-3",
    );
    const rows = mixedRows();
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          address: { serverId: SERVER_ID, agentId: "child" },
          hasActiveDescendants: false,
        }),
        expect.objectContaining({
          address: { serverId: "server-2", agentId: "child" },
          hasActiveDescendants: true,
        }),
      ]),
    );
    expect(countFinishedSubagents(rows)).toBe(1);
    setAgents([grandchild], "server-3");
    expect(countFinishedSubagents(mixedRows())).toBe(2);
    useProviderSubagentStore
      .getState()
      .replaceList("server-3", "grandchild", [
        native({ id: "native", parentAgentId: "grandchild", status: "running" }),
      ]);
    expect(countFinishedSubagents(mixedRows())).toBe(1);
    expect(
      activity().managed.has(managedActivityKey({ serverId: SERVER_ID, agentId: "child" })),
    ).toBe(false);
    expect(
      activity().managed.has(managedActivityKey({ serverId: "server-2", agentId: "child" })),
    ).toBe(true);
    useSessionStore.getState().updateSessionServerInfo("server-3", {
      serverId: "server-3",
      hostname: null,
      version: null,
      features: { providerSubagents: false },
    });
    expect(countFinishedSubagents(mixedRows())).toBe(2);
  });

  it("respects remote archive, reparenting and pending-archive boundaries without hiding a same-ID sibling", () => {
    const { remoteChild, grandchild } = seedCrossHostTree();
    setAgents([{ ...grandchild, status: "initializing" }], "server-3");
    const pending = new Set(["server-2:child"]);
    const current = getSubagentActivity({
      sessions: useSessionStore.getState().sessions,
      ...useProviderSubagentStore.getState(),
      pendingArchiveKeys: pending,
    });
    const visible = selectSubagentsForParent(
      useSessionStore.getState(),
      {
        serverId: SERVER_ID,
        parentAgentId: "parent",
      },
      pending,
      current,
    );
    expect(visible).toEqual([
      expect.objectContaining({
        address: { serverId: SERVER_ID, agentId: "child" },
        hasActiveDescendants: false,
      }),
    ]);
    expect(
      current.managed.has(managedActivityKey({ serverId: SERVER_ID, agentId: "parent" })),
    ).toBe(false);
    setAgents([{ ...remoteChild, archivedAt: AGENT_TIMESTAMP }], "server-2");
    expect(countFinishedSubagents(mixedRows())).toBe(1);
    expect(
      activity().managed.has(managedActivityKey({ serverId: SERVER_ID, agentId: "parent" })),
    ).toBe(false);
    setAgents(
      [
        {
          ...remoteChild,
          labels: { "paseo.parent-agent-id": "parent", "paseo.parent-server-id": "server-3" },
        },
      ],
      "server-2",
    );
    setAgents(
      [
        makeAgent({ id: "parent", serverId: "server-3" }),
        { ...grandchild, status: "initializing" },
      ],
      "server-3",
    );
    expect(
      activity().managed.has(managedActivityKey({ serverId: SERVER_ID, agentId: "parent" })),
    ).toBe(false);
    expect(
      activity().managed.has(managedActivityKey({ serverId: "server-3", agentId: "parent" })),
    ).toBe(true);
  });

  it("hydrates unopened descendants through their owning host and resyncs the remote list", async () => {
    seedCrossHostTree();
    const requests: AgentAddress[] = [];
    let running = true;
    function client(serverId: string) {
      return {
        async listProviderSubagents(parentAgentId: string) {
          requests.push({ serverId, agentId: parentAgentId });
          return {
            requestId: "list",
            parentAgentId,
            error: null,
            subagents:
              serverId === "server-3"
                ? [
                    native({
                      id: "native",
                      parentAgentId,
                      status: running ? "running" : "completed",
                    }),
                  ]
                : [],
          };
        },
      };
    }
    const stored = useSessionStore.getState().sessions;
    const remoteClient = client("server-3");
    const sessions = {
      [SERVER_ID]: { ...stored[SERVER_ID]!, client: client(SERVER_ID) },
      "server-2": { ...stored["server-2"]!, client: client("server-2") },
      "server-3": { ...stored["server-3"]!, client: remoteClient },
    };
    const parent = { serverId: SERVER_ID, agentId: "parent" };
    await hydrateSubagentActivity(sessions, activity(), parent);
    expect(requests).toEqual([
      parent,
      { serverId: SERVER_ID, agentId: "child" },
      { serverId: "server-2", agentId: "child" },
      { serverId: "server-3", agentId: "grandchild" },
    ]);
    expect(countFinishedSubagents(mixedRows())).toBe(1);
    await hydrateSubagentActivity(sessions, activity(), parent);
    expect(requests).toHaveLength(4);
    running = false;
    await resyncProviderSubagents(remoteClient, "server-3");
    expect(requests.at(-1)).toEqual({ serverId: "server-3", agentId: "grandchild" });
    expect(countFinishedSubagents(mixedRows())).toBe(2);
  });

  it("retries bulk archive after every host directory has hydrated, protecting newly discovered work", async () => {
    setAgents([makeAgent({ id: "parent" }), makeAgent({ id: "child", parentAgentId: "parent" })]);
    useSessionStore.getState().setHasHydratedAgents(SERVER_ID, true);
    useSessionStore.getState().updateSessionServerInfo(SERVER_ID, {
      serverId: SERVER_ID,
      hostname: null,
      version: null,
      features: { providerSubagents: false },
    });
    useSessionStore.getState().initializeSession("server-2", null);
    const parent = { serverId: SERVER_ID, agentId: "parent" };
    // Ordinary display hydration must remain usable while the other directory loads.
    await expect(
      hydrateSubagentActivity(useSessionStore.getState().sessions, activity(), parent),
    ).resolves.toBeUndefined();
    const calls: AgentAddress[] = [];
    const archive = createArchiveFinishedSubagents(mixedRows(), {
      parentAgentId: "parent",
      hydrateActivity: () => hydrateArchiveFinishedActivity(parent),
      getManagedSubagent: (address) => {
        const agent = useSessionStore
          .getState()
          .sessions[address.serverId]?.agents.get(address.agentId);
        return agent
          ? { ...agent, hasActiveDescendants: activity().managed.has(managedActivityKey(address)) }
          : undefined;
      },
      archiveManagedSubagent: async (address) => {
        calls.push(address);
      },
      dismissProviderSubagents: () => undefined,
    });
    const unhydrated = await archive.archiveFinished();
    expect(unhydrated.failures).toHaveLength(1);
    expect(unhydrated.failures[0]?.error).toBeInstanceOf(DaemonConnectionError);
    expect(archive.getState().status.kind).toBe("failed");
    expect(calls).toEqual([]);
    const remote = makeAgent({
      id: "grandchild",
      serverId: "server-2",
      status: "running",
      turn: { phase: "open", turnId: null, startedAt: null, cancellationRequestId: null },
      labels: { "paseo.parent-agent-id": "child", "paseo.parent-server-id": SERVER_ID },
    });
    useSessionStore.getState().setAgents("server-2", new Map([[remote.id, remote]]));
    useSessionStore.getState().setHasHydratedAgents("server-2", true);
    // Retain the stale eligible row: preflight and the latest-store check must protect it.
    const active = await archive.archiveFinished();
    expect(active.failures).toEqual([]);
    expect(active.skippedPaseoIds).toEqual(["child"]);
    expect(calls).toEqual([]);
    useSessionStore.getState().setAgents(
      "server-2",
      new Map([
        [
          remote.id,
          {
            ...remote,
            status: "idle",
            turn: { phase: "idle", cancellationRequestId: null },
          },
        ],
      ]),
    );
    archive.setRows(mixedRows());
    expect((await archive.archiveFinished()).archivedPaseoIds).toEqual(["child"]);
    expect(calls).toEqual([{ serverId: SERVER_ID, agentId: "child" }]);
  });

  it("rechecks a remote subtree after archiving a same-ID local sibling", async () => {
    seedCrossHostTree();
    const calls: AgentAddress[] = [];
    const archive = createArchiveFinishedSubagents(mixedRows(), {
      parentAgentId: "parent",
      hydrateActivity: async () => undefined,
      getManagedSubagent: (address) => {
        const agent = useSessionStore
          .getState()
          .sessions[address.serverId]?.agents.get(address.agentId);
        if (!agent) return undefined;
        const parent = getParentAddressFromLabels(agent.labels, address.serverId);
        if (parent?.serverId !== SERVER_ID || parent.agentId !== "parent") return undefined;
        return {
          ...agent,
          parentAgentId: parent.agentId,
          hasActiveDescendants: activity().managed.has(managedActivityKey(address)),
        };
      },
      archiveManagedSubagent: async (address) => {
        calls.push(address);
        useProviderSubagentStore.getState().replaceList("server-3", "grandchild", [
          native({
            id: "started-while-archiving",
            parentAgentId: "grandchild",
            status: "running",
          }),
        ]);
      },
      dismissProviderSubagents: () => undefined,
    });
    const result = await archive.archiveFinished();
    expect(calls).toEqual([{ serverId: SERVER_ID, agentId: "child" }]);
    expect(result.skippedPaseoIds).toEqual(["child"]);
  });
});

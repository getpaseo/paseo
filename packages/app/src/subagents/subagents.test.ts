import type { DaemonClient } from "@server/client/daemon-client";
import { afterEach, describe, expect, it } from "vitest";
import { selectSubagentsForParent } from "./subagents";
import { useSessionStore, type Agent } from "@/stores/session-store";

const SERVER_ID = "server-1";

function makeAgent(input: Partial<Agent> & Pick<Agent, "id">): Agent {
  const timestamp = new Date("2026-03-08T10:00:00.000Z");
  return {
    serverId: input.serverId ?? SERVER_ID,
    id: input.id,
    provider: input.provider ?? "codex",
    status: input.status ?? "idle",
    createdAt: input.createdAt ?? timestamp,
    updatedAt: input.updatedAt ?? timestamp,
    lastUserMessageAt: input.lastUserMessageAt ?? null,
    lastActivityAt: input.lastActivityAt ?? timestamp,
    capabilities: input.capabilities ?? {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: input.currentModeId ?? null,
    availableModes: input.availableModes ?? [],
    pendingPermissions: input.pendingPermissions ?? [],
    persistence: input.persistence ?? null,
    runtimeInfo: input.runtimeInfo,
    lastUsage: input.lastUsage,
    lastError: input.lastError ?? null,
    title: input.title ?? "Agent",
    cwd: input.cwd ?? "/tmp/project",
    model: input.model ?? null,
    features: input.features,
    thinkingOptionId: input.thinkingOptionId,
    requiresAttention: input.requiresAttention ?? false,
    attentionReason: input.attentionReason ?? null,
    attentionTimestamp: input.attentionTimestamp ?? null,
    archivedAt: input.archivedAt ?? null,
    parentAgentId: input.parentAgentId ?? null,
    labels: input.labels ?? {},
    projectPlacement: input.projectPlacement ?? null,
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

    const rows = selectSubagentsForParent(useSessionStore.getState(), {
      serverId: SERVER_ID,
      parentAgentId: "parent-a",
    });

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

    const rows = selectSubagentsForParent(useSessionStore.getState(), {
      serverId: SERVER_ID,
      parentAgentId: "parent-a",
    });

    expect(rows.map((row) => row.id)).toEqual(["child-a"]);
  });

  it("shows only direct children for each parent", () => {
    setAgents([
      makeAgent({ id: "parent" }),
      makeAgent({ id: "child", parentAgentId: "parent" }),
      makeAgent({ id: "grandchild", parentAgentId: "child" }),
    ]);

    const parentRows = selectSubagentsForParent(useSessionStore.getState(), {
      serverId: SERVER_ID,
      parentAgentId: "parent",
    });
    const childRows = selectSubagentsForParent(useSessionStore.getState(), {
      serverId: SERVER_ID,
      parentAgentId: "child",
    });

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

    const rows = selectSubagentsForParent(useSessionStore.getState(), {
      serverId: SERVER_ID,
      parentAgentId: "parent",
    });

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

    const rows = selectSubagentsForParent(useSessionStore.getState(), {
      serverId: SERVER_ID,
      parentAgentId: "parent",
    });

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
      selectSubagentsForParent(useSessionStore.getState(), {
        serverId: SERVER_ID,
        parentAgentId: "parent-a",
      }).map((row) => row.id),
    ).toEqual(["child"]);
    expect(
      selectSubagentsForParent(useSessionStore.getState(), {
        serverId: SERVER_ID,
        parentAgentId: "parent-b",
      }).map((row) => row.id),
    ).toEqual([]);

    setAgents([
      makeAgent({ id: "parent-a" }),
      makeAgent({ id: "parent-b" }),
      { ...child, parentAgentId: "parent-b" },
    ]);

    expect(
      selectSubagentsForParent(useSessionStore.getState(), {
        serverId: SERVER_ID,
        parentAgentId: "parent-a",
      }).map((row) => row.id),
    ).toEqual([]);
    expect(
      selectSubagentsForParent(useSessionStore.getState(), {
        serverId: SERVER_ID,
        parentAgentId: "parent-b",
      }).map((row) => row.id),
    ).toEqual(["child"]);
  });
});

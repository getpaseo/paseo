import { describe, expect, it } from "vitest";
import type { Agent } from "@/stores/session-store";
import {
  getSubagentActivityIndex,
  mergeSubagentActivity,
  selectSubagentActivity,
} from "./subagent-activity";

function agent(input: {
  id: string;
  status?: Agent["status"];
  phase?: "idle" | "open";
  parentAgentId?: string | null;
  archivedAt?: string | null;
  pendingPermissionCount?: number;
  attentionReason?: Agent["attentionReason"];
}): Agent {
  const status = input.status ?? "idle";
  const phase = input.phase ?? (status === "running" ? "open" : "idle");
  return {
    serverId: "host-a",
    id: input.id,
    provider: "codex",
    status,
    turn:
      phase === "open"
        ? { phase: "open", turnId: "turn-1", startedAt: null, cancellationRequestId: null }
        : { phase: "idle", cancellationRequestId: null },
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastUserMessageAt: null,
    lastActivityAt: new Date("2026-01-01T00:00:00.000Z"),
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
    pendingPermissions: Array.from({ length: input.pendingPermissionCount ?? 0 }, (_, index) => ({
      id: `permission-${index}`,
      provider: "codex",
      name: "shell",
      kind: "tool",
      input: {},
    })),
    persistence: null,
    title: null,
    cwd: "/repo",
    workspaceId: "workspace-a",
    model: null,
    requiresAttention: false,
    attentionReason: input.attentionReason ?? null,
    attentionTimestamp: null,
    archivedAt: input.archivedAt ? new Date(input.archivedAt) : null,
    parentAgentId: input.parentAgentId ?? null,
    labels: {},
  };
}

function directory(...agents: Agent[]): Map<string, Agent> {
  return new Map(agents.map((value) => [value.id, value]));
}

describe("subagent activity", () => {
  it("is idle when there are no descendants", () => {
    const agents = directory(agent({ id: "parent" }));
    expect(selectSubagentActivity(agents, "parent")).toBe("none");
  });

  it("is active while a child is running", () => {
    const agents = directory(
      agent({ id: "parent" }),
      agent({ id: "child", status: "running", parentAgentId: "parent" }),
    );
    expect(selectSubagentActivity(agents, "parent")).toBe("active");
  });

  it("counts an initializing child as active", () => {
    const agents = directory(
      agent({ id: "parent" }),
      agent({ id: "child", status: "initializing", parentAgentId: "parent" }),
    );
    expect(selectSubagentActivity(agents, "parent")).toBe("active");
  });

  it("follows an idle child to a running grandchild", () => {
    const agents = directory(
      agent({ id: "parent" }),
      agent({ id: "child", parentAgentId: "parent" }),
      agent({ id: "grandchild", status: "running", parentAgentId: "child" }),
    );
    expect(selectSubagentActivity(agents, "parent")).toBe("active");
  });

  it("reports blocked when a child waits on permission", () => {
    const agents = directory(
      agent({ id: "parent" }),
      agent({
        id: "child",
        pendingPermissionCount: 1,
        attentionReason: "permission",
        parentAgentId: "parent",
      }),
    );
    expect(selectSubagentActivity(agents, "parent")).toBe("blocked");
  });

  it("prefers blocked over active when both are present", () => {
    const agents = directory(
      agent({ id: "parent" }),
      agent({ id: "running-child", status: "running", parentAgentId: "parent" }),
      agent({ id: "blocked-child", pendingPermissionCount: 1, parentAgentId: "parent" }),
    );
    expect(selectSubagentActivity(agents, "parent")).toBe("blocked");
  });

  it("ignores an archived child but still follows it to a live child", () => {
    const archived = directory(
      agent({ id: "parent" }),
      agent({
        id: "child",
        status: "running",
        archivedAt: "2026-01-02T00:00:00.000Z",
        parentAgentId: "parent",
      }),
    );
    expect(selectSubagentActivity(archived, "parent")).toBe("none");

    const withLiveGrandchild = directory(
      agent({ id: "parent" }),
      agent({
        id: "child",
        status: "running",
        archivedAt: "2026-01-02T00:00:00.000Z",
        parentAgentId: "parent",
      }),
      agent({ id: "grandchild", status: "running", parentAgentId: "child" }),
    );
    expect(selectSubagentActivity(withLiveGrandchild, "parent")).toBe("active");
  });

  it("does not count a detached agent that has no parent relationship", () => {
    const agents = directory(agent({ id: "parent" }), agent({ id: "detached", status: "running" }));
    expect(selectSubagentActivity(agents, "parent")).toBe("none");
  });

  it("does not count a stale running lifecycle with no open turn", () => {
    const agents = directory(
      agent({ id: "parent" }),
      agent({ id: "child", status: "running", phase: "idle", parentAgentId: "parent" }),
    );
    expect(selectSubagentActivity(agents, "parent")).toBe("none");
  });

  it("counts an open turn before the lifecycle catches up", () => {
    const agents = directory(
      agent({ id: "parent" }),
      agent({ id: "child", status: "idle", phase: "open", parentAgentId: "parent" }),
    );
    expect(selectSubagentActivity(agents, "parent")).toBe("active");
  });

  it("terminates on a broken parent cycle", () => {
    const agents = directory(
      agent({ id: "a", status: "running", parentAgentId: "b" }),
      agent({ id: "b", status: "running", parentAgentId: "a" }),
    );
    expect(selectSubagentActivity(agents, "a")).toBe("active");
  });

  it("fails safe when the directory is missing", () => {
    expect(selectSubagentActivity(undefined, "parent")).toBe("none");
    expect(selectSubagentActivity(null, "parent")).toBe("none");
    expect(selectSubagentActivity(new Map(), "parent")).toBe("none");
  });

  it("merges signals by urgency", () => {
    expect(mergeSubagentActivity("none", "none")).toBe("none");
    expect(mergeSubagentActivity("none", "active")).toBe("active");
    expect(mergeSubagentActivity("active", "blocked")).toBe("blocked");
    expect(mergeSubagentActivity()).toBe("none");
  });
});

describe("subagent activity index memoization", () => {
  it("reuses one index for a directory reference and rebuilds for a new one", () => {
    const first = directory(
      agent({ id: "parent" }),
      agent({ id: "child", status: "running", parentAgentId: "parent" }),
    );
    const index = getSubagentActivityIndex(first);

    // Repeated selector runs over an unchanged directory (token/timeline store writes) must not
    // re-walk the tree — the cached index is returned by identity.
    expect(getSubagentActivityIndex(first)).toBe(index);
    expect(selectSubagentActivity(first, "parent")).toBe("active");

    const rebuilt = directory(
      agent({ id: "parent" }),
      agent({ id: "child", status: "running", parentAgentId: "parent" }),
    );
    expect(getSubagentActivityIndex(rebuilt)).not.toBe(index);
  });

  it("reflects a child state change on the next directory reference", () => {
    const running = directory(
      agent({ id: "parent" }),
      agent({ id: "child", status: "running", parentAgentId: "parent" }),
    );
    expect(selectSubagentActivity(running, "parent")).toBe("active");

    const finished = new Map(running);
    finished.set("child", agent({ id: "child", status: "idle", parentAgentId: "parent" }));
    expect(selectSubagentActivity(finished, "parent")).toBe("none");

    const archived = new Map(running);
    archived.set(
      "child",
      agent({
        id: "child",
        status: "running",
        archivedAt: "2026-01-02T00:00:00.000Z",
        parentAgentId: "parent",
      }),
    );
    expect(selectSubagentActivity(archived, "parent")).toBe("none");

    const detached = new Map(running);
    detached.set("child", agent({ id: "child", status: "running" }));
    expect(selectSubagentActivity(detached, "parent")).toBe("none");
  });

  it("keeps each host's directory isolated", () => {
    const hostA = directory(
      agent({ id: "parent" }),
      agent({ id: "child", status: "running", parentAgentId: "parent" }),
    );
    const hostB = directory(
      agent({ id: "parent" }),
      agent({ id: "child", status: "idle", parentAgentId: "parent" }),
    );

    expect(selectSubagentActivity(hostA, "parent")).toBe("active");
    expect(selectSubagentActivity(hostB, "parent")).toBe("none");
    // Caching host A must not leak the reused agent id into host B, or the reverse.
    expect(selectSubagentActivity(hostA, "parent")).toBe("active");
    expect(selectSubagentActivity(hostB, "parent")).toBe("none");
  });
});

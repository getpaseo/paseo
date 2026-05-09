/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@server/client/daemon-client";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { useAggregatedAgentIds, useAggregatedAgents } from "./use-aggregated-agents";

const { mockRuntimeStore } = vi.hoisted(() => ({
  mockRuntimeStore: {
    subscribeAll: vi.fn(() => () => undefined),
    getVersion: vi.fn(() => 1),
    getSnapshot: vi.fn(() => ({ agentDirectoryStatus: "idle" })),
    refreshAllAgentDirectories: vi.fn(),
  },
}));

vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => mockRuntimeStore,
  useHosts: () => [{ serverId: "server-1", label: "Local" }],
}));

const TIMESTAMP = new Date("2026-05-08T10:00:00.000Z");

const AGENT_DEFAULTS: Agent = {
  serverId: "server-1",
  id: "agent-1",
  provider: "codex",
  status: "idle",
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
  lastUserMessageAt: null,
  lastActivityAt: TIMESTAMP,
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
  thinkingOptionId: undefined,
  requiresAttention: false,
  attentionReason: null,
  attentionTimestamp: null,
  archivedAt: null,
  labels: {},
  projectPlacement: null,
};

function makeAgent(input: Partial<Agent>): Agent {
  return { ...AGENT_DEFAULTS, ...input };
}

function seedAgents(agents: Agent[]) {
  act(() => {
    useSessionStore.getState().initializeSession("server-1", {} as unknown as DaemonClient);
    useSessionStore
      .getState()
      .setAgents("server-1", new Map(agents.map((agent) => [agent.id, agent])));
  });
}

afterEach(() => {
  mockRuntimeStore.subscribeAll.mockClear();
  mockRuntimeStore.getVersion.mockClear();
  mockRuntimeStore.getSnapshot.mockClear();
  mockRuntimeStore.refreshAllAgentDirectories.mockClear();
  useSessionStore.setState({ sessions: {}, agentLastActivity: new Map() });
});

describe("useAggregatedAgents", () => {
  it("sorts by createdAt descending by default and falls back to id for ties", () => {
    seedAgents([
      makeAgent({
        id: "beta",
        createdAt: new Date("2026-05-08T10:00:00.000Z"),
      }),
      makeAgent({
        id: "newest",
        createdAt: new Date("2026-05-08T11:00:00.000Z"),
      }),
      makeAgent({
        id: "alpha",
        createdAt: new Date("2026-05-08T10:00:00.000Z"),
      }),
    ]);

    const { result } = renderHook(() => useAggregatedAgents());

    expect(result.current.agents.map((agent) => agent.id)).toEqual(["newest", "alpha", "beta"]);
  });

  it("can preserve the legacy running-then-activity sort", () => {
    seedAgents([
      makeAgent({
        id: "idle-newer",
        status: "idle",
        lastActivityAt: new Date("2026-05-08T12:00:00.000Z"),
      }),
      makeAgent({
        id: "running-older",
        status: "running",
        lastActivityAt: new Date("2026-05-08T09:00:00.000Z"),
      }),
      makeAgent({
        id: "running-newer",
        status: "running",
        lastActivityAt: new Date("2026-05-08T11:00:00.000Z"),
      }),
    ]);

    const { result } = renderHook(() => useAggregatedAgents({ sort: "running-then-activity" }));

    expect(result.current.agents.map((agent) => agent.id)).toEqual([
      "running-newer",
      "running-older",
      "idle-newer",
    ]);
  });
});

describe("useAggregatedAgentIds", () => {
  it("keeps the same id array reference when membership and order are unchanged", () => {
    seedAgents([
      makeAgent({
        id: "alpha",
        title: "Alpha",
        status: "idle",
        createdAt: new Date("2026-05-08T10:00:00.000Z"),
        lastActivityAt: new Date("2026-05-08T10:00:00.000Z"),
      }),
      makeAgent({
        id: "beta",
        title: "Beta",
        status: "running",
        createdAt: new Date("2026-05-08T11:00:00.000Z"),
        lastActivityAt: new Date("2026-05-08T11:00:00.000Z"),
      }),
    ]);

    const { result } = renderHook(() => useAggregatedAgentIds());
    const before = result.current;

    act(() => {
      useSessionStore.getState().setAgents(
        "server-1",
        new Map([
          [
            "alpha",
            makeAgent({
              id: "alpha",
              title: "Renamed Alpha",
              status: "running",
              createdAt: new Date("2026-05-08T10:00:00.000Z"),
              lastActivityAt: new Date("2026-05-08T12:00:00.000Z"),
            }),
          ],
          [
            "beta",
            makeAgent({
              id: "beta",
              title: "Renamed Beta",
              status: "idle",
              createdAt: new Date("2026-05-08T11:00:00.000Z"),
              lastActivityAt: new Date("2026-05-08T12:30:00.000Z"),
            }),
          ],
        ]),
      );
    });

    expect(result.current).toBe(before);
    expect(result.current).toEqual(["beta", "alpha"]);
  });

  it("changes the id array reference when membership changes", () => {
    seedAgents([makeAgent({ id: "alpha" })]);

    const { result } = renderHook(() => useAggregatedAgentIds());
    const before = result.current;

    act(() => {
      useSessionStore.getState().setAgents(
        "server-1",
        new Map([
          ["alpha", makeAgent({ id: "alpha" })],
          ["beta", makeAgent({ id: "beta", createdAt: new Date("2026-05-08T11:00:00.000Z") })],
        ]),
      );
    });

    expect(result.current).not.toBe(before);
    expect(result.current).toEqual(["beta", "alpha"]);
  });

  it("keeps the same id array reference when a local predicate still yields the same ids", () => {
    seedAgents([
      makeAgent({ id: "mapped", cwd: "/tmp/project" }),
      makeAgent({
        id: "unmapped",
        cwd: "/tmp/missing",
        createdAt: new Date("2026-05-08T11:00:00.000Z"),
      }),
    ]);

    const { result } = renderHook(() =>
      useAggregatedAgentIds({
        filter: (agent) => agent.cwd === "/tmp/project" && !agent.archivedAt,
      }),
    );
    const before = result.current;

    act(() => {
      useSessionStore.getState().setAgents(
        "server-1",
        new Map([
          ["mapped", makeAgent({ id: "mapped", cwd: "/tmp/project", title: "Renamed" })],
          [
            "unmapped",
            makeAgent({
              id: "unmapped",
              cwd: "/tmp/missing",
              title: "Still hidden",
              createdAt: new Date("2026-05-08T11:00:00.000Z"),
            }),
          ],
        ]),
      );
    });

    expect(result.current).toBe(before);
    expect(result.current).toEqual(["mapped"]);
  });
});

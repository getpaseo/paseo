/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { useAggregatedAgents } from "./use-aggregated-agents";

const runtime = vi.hoisted(() => ({
  acquireDirectoryDemand: () => () => undefined,
  subscribeAll: () => () => undefined,
  getVersion: () => 0,
  getSnapshot: () => ({ agentDirectoryStatus: "ready" as const }),
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => [{ serverId: "srv_a", label: "Host A" }],
  getHostRuntimeStore: () => runtime,
}));

const SERVER_ID = "srv_a";

function agent(id: string): Agent {
  const updatedAt = new Date("2026-01-01T00:00:00.000Z");
  return {
    serverId: SERVER_ID,
    id,
    provider: "codex",
    status: "idle",
    turn: { phase: "idle", cancellationRequestId: null },
    createdAt: updatedAt,
    updatedAt,
    lastUserMessageAt: null,
    lastActivityAt: updatedAt,
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
    title: id,
    cwd: "/repo",
    workspaceId: "workspace-1",
    model: null,
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    archivedAt: null,
    parentAgentId: null,
    background: false,
    labels: {},
  };
}

function publish(count: number): void {
  useSessionStore
    .getState()
    .setAgents(
      SERVER_ID,
      new Map(
        Array.from({ length: count }, (_, index) => [agent(`a${index}`).id, agent(`a${index}`)]),
      ),
    );
}

describe("useAggregatedAgents", () => {
  let root: Root | null = null;
  let renders = 0;
  let seen = 0;

  function Probe({ demand }: { demand: boolean }) {
    renders += 1;
    const { agents } = useAggregatedAgents({ demand });
    seen = agents.length;
    return null;
  }

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    renders = 0;
    seen = 0;
    vi.restoreAllMocks();
  });

  function mount(demand: boolean): void {
    useSessionStore.getState().initializeSession(SERVER_ID, null as never);
    const container = document.createElement("div");
    root = createRoot(container);
    act(() => root?.render(<Probe demand={demand} />));
  }

  it("follows the directory while it is demanded", () => {
    mount(true);
    expect(seen).toBe(0);

    act(() => publish(3));
    expect(seen).toBe(3);
  });

  it("stays off the agent maps when the caller does not need them", () => {
    mount(false);
    const afterMount = renders;
    expect(seen).toBe(0);

    act(() => publish(3));
    act(() => publish(4));

    // A closed surface must not re-render or rebuild the list for every directory update.
    expect(renders).toBe(afterMount);
    expect(seen).toBe(0);
  });
});

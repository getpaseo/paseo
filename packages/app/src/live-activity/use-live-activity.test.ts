/**
 * @vitest-environment jsdom
 */
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStore, type Agent } from "@/stores/session-store";
import type { FleetSnapshot } from "./fleet-snapshot";
import type { FleetReceipt } from "./presenter";
import { useLiveActivityController as useLiveActivity } from "./use-live-activity-controller";

const presenterMock = vi.hoisted(() => ({
  supported: vi.fn<() => boolean>(() => true),
  start: vi.fn<(snapshot: FleetSnapshot) => Promise<void>>(async (_snapshot) => {}),
  update: vi.fn<(snapshot: FleetSnapshot) => Promise<void>>(async (_snapshot) => {}),
  end: vi.fn<(receipt: FleetReceipt) => Promise<void>>(async (_receipt) => {}),
}));

vi.mock("./presenter", () => presenterMock);

const hostRuntimeMock = vi.hoisted(() => ({
  useHostRuntimeIsConnected: vi.fn(() => true),
}));

vi.mock("@/runtime/host-runtime", () => hostRuntimeMock);

const SERVER_ID = "live-activity-server";
const NOW = new Date("2026-04-01T03:00:00.000Z");

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    serverId: SERVER_ID,
    id: "agent-1",
    provider: "codex",
    status: "idle",
    createdAt: NOW,
    updatedAt: NOW,
    lastUserMessageAt: null,
    lastActivityAt: NOW,
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
    title: "Agent under test",
    cwd: "/repo",
    model: null,
    parentAgentId: null,
    labels: {},
    archivedAt: null,
    ...overrides,
    activeTurn: overrides.activeTurn ?? null,
  };
}

function setAgents(agents: Agent[]): void {
  useSessionStore
    .getState()
    .setAgents(SERVER_ID, new Map(agents.map((agent) => [agent.id, agent])));
}

describe("useLiveActivity", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    presenterMock.supported.mockReturnValue(true);
    presenterMock.start.mockClear();
    presenterMock.update.mockClear();
    presenterMock.end.mockClear();
    hostRuntimeMock.useHostRuntimeIsConnected.mockReturnValue(true);
    useSessionStore.getState().initializeSession(SERVER_ID, null as unknown as DaemonClient);
  });

  afterEach(() => {
    cleanup();
    useSessionStore.getState().clearSession(SERVER_ID);
    vi.useRealTimers();
  });

  it("does nothing when the presenter is unsupported", () => {
    presenterMock.supported.mockReturnValue(false);
    renderHook(() => useLiveActivity({ serverId: SERVER_ID }));

    act(() => {
      setAgents([makeAgent({ status: "running", activeTurn: { turnId: "t1", startedAt: NOW } })]);
    });

    expect(presenterMock.start).not.toHaveBeenCalled();
  });

  it("starts the activity immediately when the fleet goes active", () => {
    renderHook(() => useLiveActivity({ serverId: SERVER_ID }));

    act(() => {
      setAgents([makeAgent({ status: "running", activeTurn: { turnId: "t1", startedAt: NOW } })]);
    });

    expect(presenterMock.start).toHaveBeenCalledTimes(1);
    expect(presenterMock.start.mock.calls[0]?.[0]?.active).toBe(true);
    expect(presenterMock.start.mock.calls[0]?.[0]?.hero?.agentId).toBe("agent-1");
  });

  it("debounces an update 1000ms after a material change, keeping the hero via hysteresis", () => {
    renderHook(() => useLiveActivity({ serverId: SERVER_ID }));

    act(() => {
      setAgents([
        makeAgent({
          id: "agent-1",
          status: "running",
          activeTurn: { turnId: "t1", startedAt: NOW },
        }),
      ]);
    });
    expect(presenterMock.start).toHaveBeenCalledTimes(1);

    act(() => {
      setAgents([
        makeAgent({
          id: "agent-1",
          status: "running",
          activeTurn: { turnId: "t1", startedAt: NOW },
        }),
        makeAgent({
          id: "agent-2",
          status: "running",
          activeTurn: { turnId: "t2", startedAt: NOW },
        }),
      ]);
    });
    expect(presenterMock.update).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(presenterMock.update).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(presenterMock.update).toHaveBeenCalledTimes(1);
    expect(presenterMock.update.mock.calls[0]?.[0]?.hero?.agentId).toBe("agent-1");
    expect(presenterMock.update.mock.calls[0]?.[0]?.runningCount).toBe(2);
  });

  it("does not schedule an update when nothing material changed", () => {
    renderHook(() => useLiveActivity({ serverId: SERVER_ID }));

    act(() => {
      setAgents([makeAgent({ status: "running", activeTurn: { turnId: "t1", startedAt: NOW } })]);
    });

    act(() => {
      setAgents([makeAgent({ status: "running", activeTurn: { turnId: "t1", startedAt: NOW } })]);
      vi.advanceTimersByTime(1000);
    });

    expect(presenterMock.update).not.toHaveBeenCalled();
  });

  it("ends the activity with a receipt after a 120s grace period once the fleet goes inactive", () => {
    renderHook(() => useLiveActivity({ serverId: SERVER_ID }));

    act(() => {
      setAgents([makeAgent({ status: "running", activeTurn: { turnId: "t1", startedAt: NOW } })]);
    });
    expect(presenterMock.start).toHaveBeenCalledTimes(1);

    act(() => {
      setAgents([makeAgent({ status: "idle" })]);
    });
    expect(presenterMock.end).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(119_999);
    });
    expect(presenterMock.end).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(presenterMock.end).toHaveBeenCalledTimes(1);
    expect(presenterMock.end.mock.calls[0]?.[0]?.finishedTitle).toBe("Agent under test");
    expect(presenterMock.end.mock.calls[0]?.[0]?.durationMs).toBeGreaterThanOrEqual(120_000);
  });

  it("cancels the grace timer when the fleet becomes active again before it fires", () => {
    renderHook(() => useLiveActivity({ serverId: SERVER_ID }));

    act(() => {
      setAgents([makeAgent({ status: "running", activeTurn: { turnId: "t1", startedAt: NOW } })]);
    });
    act(() => {
      setAgents([makeAgent({ status: "idle" })]);
    });

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    act(() => {
      setAgents([makeAgent({ status: "running", activeTurn: { turnId: "t1", startedAt: NOW } })]);
    });

    act(() => {
      vi.advanceTimersByTime(120_000);
    });

    expect(presenterMock.end).not.toHaveBeenCalled();
    expect(presenterMock.start).toHaveBeenCalledTimes(1);
  });

  it("ends immediately on unmount, bypassing the grace period", () => {
    const { unmount } = renderHook(() => useLiveActivity({ serverId: SERVER_ID }));

    act(() => {
      setAgents([makeAgent({ status: "running", activeTurn: { turnId: "t1", startedAt: NOW } })]);
    });
    expect(presenterMock.start).toHaveBeenCalledTimes(1);

    act(() => {
      unmount();
    });

    expect(presenterMock.end).toHaveBeenCalledTimes(1);
  });

  it("ends immediately when the daemon disconnects", () => {
    const { rerender } = renderHook(() => useLiveActivity({ serverId: SERVER_ID }));

    act(() => {
      setAgents([makeAgent({ status: "running", activeTurn: { turnId: "t1", startedAt: NOW } })]);
    });
    expect(presenterMock.start).toHaveBeenCalledTimes(1);

    act(() => {
      hostRuntimeMock.useHostRuntimeIsConnected.mockReturnValue(false);
      rerender();
    });

    expect(presenterMock.end).toHaveBeenCalledTimes(1);
  });

  it("does not apply a debounced update after the activity has ended", () => {
    renderHook(() => useLiveActivity({ serverId: SERVER_ID }));

    act(() => {
      setAgents([makeAgent({ status: "running", activeTurn: { turnId: "t1", startedAt: NOW } })]);
    });
    act(() => {
      useSessionStore.getState().setAgentStreamState(SERVER_ID, "agent-1", {
        taskSnapshot: [
          { text: "Step", activeForm: "Running step", completed: false, status: "in_progress" },
        ],
      });
    });

    act(() => {
      setAgents([makeAgent({ status: "idle" })]);
    });
    act(() => {
      vi.advanceTimersByTime(120_000);
    });

    expect(presenterMock.end).toHaveBeenCalledTimes(1);
    expect(presenterMock.update).not.toHaveBeenCalled();
  });

  it("clears a pending debounced update when the fleet goes idle", () => {
    renderHook(() => useLiveActivity({ serverId: SERVER_ID }));

    act(() => {
      setAgents([
        makeAgent({
          id: "agent-1",
          status: "running",
          activeTurn: { turnId: "t1", startedAt: NOW },
        }),
      ]);
    });
    act(() => {
      setAgents([
        makeAgent({
          id: "agent-1",
          status: "running",
          activeTurn: { turnId: "t1", startedAt: NOW },
        }),
        makeAgent({
          id: "agent-2",
          status: "running",
          activeTurn: { turnId: "t2", startedAt: NOW },
        }),
      ]);
    });

    act(() => {
      setAgents([makeAgent({ status: "idle" })]);
    });

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(presenterMock.update).not.toHaveBeenCalled();
  });

  it("delivers a pending material update after the fleet resumes within the grace period", () => {
    renderHook(() => useLiveActivity({ serverId: SERVER_ID }));

    act(() => {
      setAgents([
        makeAgent({
          id: "agent-1",
          status: "running",
          activeTurn: { turnId: "t1", startedAt: NOW },
        }),
      ]);
    });
    act(() => {
      setAgents([
        makeAgent({
          id: "agent-1",
          status: "running",
          activeTurn: { turnId: "t1", startedAt: NOW },
        }),
        makeAgent({
          id: "agent-2",
          status: "running",
          activeTurn: { turnId: "t2", startedAt: NOW },
        }),
      ]);
    });

    act(() => {
      setAgents([makeAgent({ status: "idle" })]);
    });

    act(() => {
      setAgents([
        makeAgent({
          id: "agent-1",
          status: "running",
          activeTurn: { turnId: "t1", startedAt: NOW },
        }),
        makeAgent({
          id: "agent-2",
          status: "running",
          activeTurn: { turnId: "t2", startedAt: NOW },
        }),
      ]);
    });

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(presenterMock.update).toHaveBeenCalledTimes(1);
    expect(presenterMock.update.mock.calls[0]?.[0]?.runningCount).toBe(2);
  });

  it("starts again and resets hysteresis after reconnecting to an active fleet", () => {
    const { rerender } = renderHook(() => useLiveActivity({ serverId: SERVER_ID }));

    act(() => {
      setAgents([
        makeAgent({
          id: "agent-hero",
          status: "running",
          activeTurn: { turnId: "t1", startedAt: NOW },
        }),
        makeAgent({
          id: "agent-fresher",
          status: "running",
          activeTurn: { turnId: "t2", startedAt: new Date(NOW.getTime() - 60_000) },
        }),
      ]);
    });
    expect(presenterMock.start).toHaveBeenCalledTimes(1);
    expect(presenterMock.start.mock.calls[0]?.[0]?.hero?.agentId).toBe("agent-fresher");

    act(() => {
      hostRuntimeMock.useHostRuntimeIsConnected.mockReturnValue(false);
      rerender();
    });
    expect(presenterMock.end).toHaveBeenCalledTimes(1);

    act(() => {
      hostRuntimeMock.useHostRuntimeIsConnected.mockReturnValue(true);
      rerender();
    });

    expect(presenterMock.start).toHaveBeenCalledTimes(2);
    expect(presenterMock.start.mock.calls[1]?.[0]?.hero?.agentId).toBe("agent-fresher");
  });

  it("suppresses a pending debounced update when the daemon disconnects", () => {
    const { rerender } = renderHook(() => useLiveActivity({ serverId: SERVER_ID }));

    act(() => {
      setAgents([makeAgent({ status: "running", activeTurn: { turnId: "t1", startedAt: NOW } })]);
    });
    act(() => {
      setAgents([
        makeAgent({
          id: "agent-1",
          status: "running",
          activeTurn: { turnId: "t1", startedAt: NOW },
        }),
        makeAgent({
          id: "agent-2",
          status: "running",
          activeTurn: { turnId: "t2", startedAt: NOW },
        }),
      ]);
    });

    act(() => {
      hostRuntimeMock.useHostRuntimeIsConnected.mockReturnValue(false);
      rerender();
    });

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(presenterMock.end).toHaveBeenCalledTimes(1);
    expect(presenterMock.update).not.toHaveBeenCalled();
  });

  it("does not let an in-flight update land after end", async () => {
    let resolveUpdate: (() => void) | undefined;
    presenterMock.update.mockImplementation((_snapshot: FleetSnapshot) => {
      return new Promise<void>((resolve) => {
        resolveUpdate = resolve;
      });
    });

    const { rerender } = renderHook(() => useLiveActivity({ serverId: SERVER_ID }));

    act(() => {
      setAgents([makeAgent({ status: "running", activeTurn: { turnId: "t1", startedAt: NOW } })]);
    });
    act(() => {
      useSessionStore.getState().setAgentStreamState(SERVER_ID, "agent-1", {
        taskSnapshot: [
          { text: "Step", activeForm: "Running step", completed: false, status: "in_progress" },
        ],
      });
    });

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(presenterMock.update).toHaveBeenCalledTimes(1);

    act(() => {
      hostRuntimeMock.useHostRuntimeIsConnected.mockReturnValue(false);
      rerender();
    });
    expect(presenterMock.end).not.toHaveBeenCalled();

    await act(async () => {
      resolveUpdate?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(presenterMock.update).toHaveBeenCalledTimes(1);
    expect(presenterMock.end).toHaveBeenCalledTimes(1);
  });

  it("does not start an activity for finished-attention-only agents", () => {
    renderHook(() => useLiveActivity({ serverId: SERVER_ID }));

    act(() => {
      setAgents([
        makeAgent({
          status: "idle",
          requiresAttention: true,
          attentionReason: "finished",
          attentionTimestamp: NOW,
        }),
      ]);
    });

    expect(presenterMock.start).not.toHaveBeenCalled();
  });
});

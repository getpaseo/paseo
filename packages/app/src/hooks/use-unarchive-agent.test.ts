import { describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { deliverUnarchiveError } from "@/components/archived-agent-callout";
import { runAgentUnarchive } from "@/hooks/use-unarchive-agent";
import { useSessionStore } from "@/stores/session-store";
import {
  beginAgentUnarchive,
  clearUnarchiveAgentPending,
  clearUnarchiveAgentPendingForServer,
  finishAgentUnarchive,
  isAgentUnarchiving,
} from "@/stores/unarchive-agent-store";

describe("unarchive-agent-store", () => {
  it("tracks pending unarchive state per server and agent", () => {
    const first = { serverId: "server-1", agentId: "agent-a" };
    const second = { serverId: "server-1", agentId: "agent-b" };
    const otherServer = { serverId: "server-2", agentId: "agent-a" };

    expect(isAgentUnarchiving(first)).toBe(false);

    beginAgentUnarchive(first);
    expect(isAgentUnarchiving(first)).toBe(true);
    expect(isAgentUnarchiving(second)).toBe(false);
    expect(isAgentUnarchiving(otherServer)).toBe(false);

    clearUnarchiveAgentPending(first);
    expect(isAgentUnarchiving(first)).toBe(false);
  });

  it("ignores stale attempt tokens when a newer unarchive attempt owns the agent", () => {
    const target = { serverId: "server-token", agentId: "agent-1" };
    const firstToken = beginAgentUnarchive(target);
    const secondToken = beginAgentUnarchive(target);

    finishAgentUnarchive(target, firstToken);
    expect(isAgentUnarchiving(target)).toBe(true);

    finishAgentUnarchive(target, secondToken);
    expect(isAgentUnarchiving(target)).toBe(false);
  });

  it("clears pending unarchive entries for a server when its session clears", () => {
    const serverA = { serverId: "server-clear-a", agentId: "agent-1" };
    const serverB = { serverId: "server-clear-b", agentId: "agent-1" };
    const store = useSessionStore.getState();
    store.initializeSession(serverA.serverId, null as unknown as DaemonClient);
    beginAgentUnarchive(serverA);
    beginAgentUnarchive(serverB);

    store.clearSession(serverA.serverId);

    expect(isAgentUnarchiving(serverA)).toBe(false);
    expect(isAgentUnarchiving(serverB)).toBe(true);
    clearUnarchiveAgentPendingForServer(serverB.serverId);
  });

  it("ignores blank server or agent ids", () => {
    expect(beginAgentUnarchive({ serverId: " ", agentId: "agent-a" })).toBe(0);
    expect(isAgentUnarchiving({ serverId: " ", agentId: "agent-a" })).toBe(false);
    expect(beginAgentUnarchive({ serverId: "server-1", agentId: "" })).toBe(0);
    expect(isAgentUnarchiving({ serverId: "server-1", agentId: "" })).toBe(false);
  });
});

describe("runAgentUnarchive", () => {
  it("guards against missing client, disconnected host, and duplicate concurrent attempts", async () => {
    const refreshAgent = vi.fn(async () => {});
    const target = { serverId: "server-run", agentId: "agent-guard" };

    expect(await runAgentUnarchive({ ...target, client: null, isConnected: true })).toBe(false);
    expect(
      await runAgentUnarchive({ ...target, client: { refreshAgent }, isConnected: false }),
    ).toBe(false);
    expect(refreshAgent).not.toHaveBeenCalled();

    let resolveRefresh!: () => void;
    const inflightClient = {
      refreshAgent: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveRefresh = resolve;
          }),
      ),
    };
    const first = runAgentUnarchive({ ...target, client: inflightClient, isConnected: true });
    expect(isAgentUnarchiving(target)).toBe(true);

    // Duplicate click while first attempt is in flight is ignored.
    expect(await runAgentUnarchive({ ...target, client: inflightClient, isConnected: true })).toBe(
      false,
    );
    expect(inflightClient.refreshAgent).toHaveBeenCalledTimes(1);

    resolveRefresh();
    expect(await first).toBe(true);
    expect(isAgentUnarchiving(target)).toBe(false);
  });

  it("releases pending state in finally and rethrows when refreshAgent fails", async () => {
    const target = { serverId: "server-fail", agentId: "agent-fail" };
    const failingClient = {
      refreshAgent: vi.fn(async () => {
        expect(isAgentUnarchiving(target)).toBe(true);
        throw new Error("Resume failed");
      }),
    };

    await expect(
      runAgentUnarchive({ ...target, client: failingClient, isConnected: true }),
    ).rejects.toThrow("Resume failed");
    expect(isAgentUnarchiving(target)).toBe(false);
  });
});

describe("deliverUnarchiveError", () => {
  it("shows an inline error when still mounted on the same agent and falls back to toast otherwise", () => {
    const inlineErrors: Array<{ targetKey: string; message: string }> = [];
    const toastErrors: string[] = [];

    deliverUnarchiveError({
      error: new Error("Failed to resume"),
      attemptKey: "srv:agent-1",
      isMounted: true,
      currentTargetKey: "srv:agent-1",
      onInlineError: (state) => inlineErrors.push(state),
      onToastError: (message) => toastErrors.push(message),
    });
    expect(inlineErrors).toEqual([{ targetKey: "srv:agent-1", message: "Failed to resume" }]);
    expect(toastErrors).toEqual([]);

    deliverUnarchiveError({
      error: new Error("Unmounted failure"),
      attemptKey: "srv:agent-1",
      isMounted: false,
      currentTargetKey: "srv:agent-1",
      onInlineError: (state) => inlineErrors.push(state),
      onToastError: (message) => toastErrors.push(message),
    });
    deliverUnarchiveError({
      error: new Error("Switched agent failure"),
      attemptKey: "srv:agent-1",
      isMounted: true,
      currentTargetKey: "srv:agent-2",
      onInlineError: (state) => inlineErrors.push(state),
      onToastError: (message) => toastErrors.push(message),
    });
    expect(toastErrors).toEqual(["Unmounted failure", "Switched agent failure"]);
  });
});

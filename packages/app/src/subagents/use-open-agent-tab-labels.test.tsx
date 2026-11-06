/**
 * @vitest-environment jsdom
 */
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { getOpenAgentTabLabel } from "@getpaseo/protocol/agent-labels";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSessionStore, type Agent } from "@/stores/session-store";
import type { WorkspaceTab } from "@/workspace-tabs/model";
import { useOpenAgentTabLabels } from "./use-open-agent-tab-labels";

const clientId = vi.hoisted(() => ({ getOrCreateClientId: vi.fn<() => Promise<string>>() }));
vi.mock("@/utils/client-id", () => clientId);

const SERVER_ID = "server-1";
const TABS: WorkspaceTab[] = [
  { tabId: "agent_child", target: { kind: "agent", agentId: "child" }, createdAt: 1 },
];

function agent(input: { id: string; parentAgentId?: string }): Agent {
  return { id: input.id, parentAgentId: input.parentAgentId ?? null, labels: {} } as Agent;
}

afterEach(() => {
  useSessionStore.getState().clearSession(SERVER_ID);
  clientId.getOrCreateClientId.mockReset();
  vi.restoreAllMocks();
});

describe("useOpenAgentTabLabels", () => {
  it("retries a failed client id lookup on a later agent map change", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    clientId.getOrCreateClientId
      .mockRejectedValueOnce(new Error("storage unavailable"))
      .mockResolvedValue("cid-1");
    const updateAgent = vi.fn(async () => {});
    const client = { updateAgent } as unknown as DaemonClient;
    useSessionStore.getState().initializeSession(SERVER_ID, client);
    useSessionStore
      .getState()
      .setAgents(SERVER_ID, new Map([["child", agent({ id: "child", parentAgentId: "parent" })]]));

    renderHook(() =>
      useOpenAgentTabLabels({ client, serverId: SERVER_ID, tabs: TABS, enabled: true }),
    );
    await waitFor(() => expect(clientId.getOrCreateClientId).toHaveBeenCalledTimes(1));
    expect(updateAgent).not.toHaveBeenCalled();

    act(() => {
      useSessionStore.getState().setAgents(
        SERVER_ID,
        new Map([
          ["child", agent({ id: "child", parentAgentId: "parent" })],
          ["other", agent({ id: "other" })],
        ]),
      );
    });

    await waitFor(() =>
      expect(updateAgent).toHaveBeenCalledWith("child", {
        labels: { [getOpenAgentTabLabel("cid-1")]: "true" },
      }),
    );
    expect(clientId.getOrCreateClientId).toHaveBeenCalledTimes(2);
  });
});

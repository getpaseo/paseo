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
const TIMESTAMP = new Date("2026-04-21T10:00:00.000Z");
const CHILD_TAB: WorkspaceTab = {
  tabId: "agent_child",
  target: { kind: "agent", agentId: "child" },
  createdAt: 1,
};
const ROOT_TAB: WorkspaceTab = {
  tabId: "agent_root",
  target: { kind: "agent", agentId: "root" },
  createdAt: 2,
};

const AGENT_DEFAULTS: Agent = {
  serverId: SERVER_ID,
  id: "agent",
  provider: "codex",
  status: "idle",
  turn: { phase: "idle", cancellationRequestId: null },
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
  cwd: "/repo",
  workspaceId: "ws-main",
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

const CHILD: Agent = { ...AGENT_DEFAULTS, id: "child", parentAgentId: "parent" };
const ROOT: Agent = { ...AGENT_DEFAULTS, id: "root" };
const LABELLED = { labels: { [getOpenAgentTabLabel("cid-1")]: "true" } };

interface Harness {
  updateAgent: ReturnType<typeof vi.fn<DaemonClient["updateAgent"]>>;
  rerenderTabs: (tabs: WorkspaceTab[]) => void;
}

// The first client id lookup rejects and later ones succeed, as when storage recovers.
async function renderAfterFailedLookup(): Promise<Harness> {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  clientId.getOrCreateClientId
    .mockRejectedValueOnce(new Error("storage unavailable"))
    .mockResolvedValue("cid-1");
  const updateAgent = vi.fn<DaemonClient["updateAgent"]>(async () => {});
  const client: Pick<DaemonClient, "updateAgent"> = { updateAgent };
  useSessionStore.getState().initializeSession(SERVER_ID, null);
  useSessionStore.getState().setAgents(SERVER_ID, new Map([[CHILD.id, CHILD]]));

  const { rerender } = renderHook(
    ({ tabs }: { tabs: WorkspaceTab[] }) =>
      useOpenAgentTabLabels({ client, serverId: SERVER_ID, tabs, enabled: true }),
    { initialProps: { tabs: [CHILD_TAB] } },
  );
  await waitFor(() => expect(clientId.getOrCreateClientId).toHaveBeenCalledTimes(1));
  expect(updateAgent).not.toHaveBeenCalled();
  return { updateAgent, rerenderTabs: (tabs) => rerender({ tabs }) };
}

afterEach(() => {
  useSessionStore.getState().clearSession(SERVER_ID);
  clientId.getOrCreateClientId.mockReset();
  vi.restoreAllMocks();
});

describe("useOpenAgentTabLabels", () => {
  it("retries a failed client id lookup on a later agent map change", async () => {
    const { updateAgent } = await renderAfterFailedLookup();

    act(() => {
      useSessionStore.getState().setAgents(
        SERVER_ID,
        new Map([
          [CHILD.id, CHILD],
          [ROOT.id, ROOT],
        ]),
      );
    });

    await waitFor(() => expect(updateAgent).toHaveBeenCalledWith("child", LABELLED));
  });

  it("retries a failed client id lookup when the open tabs change", async () => {
    const { updateAgent, rerenderTabs } = await renderAfterFailedLookup();

    act(() => {
      rerenderTabs([CHILD_TAB, ROOT_TAB]);
    });

    await waitFor(() => expect(updateAgent).toHaveBeenCalledWith("child", LABELLED));
  });

  it("retries a failed client id lookup when only agent details change", async () => {
    const { updateAgent } = await renderAfterFailedLookup();

    act(() => {
      useSessionStore.getState().setAgentDetails(SERVER_ID, new Map([[ROOT.id, ROOT]]));
    });

    await waitFor(() => expect(updateAgent).toHaveBeenCalledWith("child", LABELLED));
  });
});

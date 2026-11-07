import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MARK_AGENT_UNREAD_LABEL,
  canMarkAgentTabUnread,
  markAgentTabUnread,
} from "@/workspace/mark-unread";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";

vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: vi.fn(),
}));

vi.mock("@/stores/workspace-layout-store", async () => {
  const actual = await vi.importActual<typeof import("@/stores/workspace-layout-store")>(
    "@/stores/workspace-layout-store",
  );
  return {
    ...actual,
    useWorkspaceLayoutStore: {
      getState: vi.fn(),
    },
  };
});

const getClient = vi.fn();
const unfocusPane = vi.fn();
const restorePaneFocus = vi.fn();
const updateAgent = vi.fn();

function layoutState(focusedTabId: string | null) {
  return {
    layoutByWorkspace: {
      "srv:ws": {
        focusedPaneId: focusedTabId ? "pane-1" : null,
        root: {
          kind: "pane",
          pane: {
            id: "pane-1",
            focusedTabId,
            tabIds: ["tab-1", "tab-other"],
          },
        },
      },
    },
    unfocusPane,
    restorePaneFocus,
  };
}

describe("canMarkAgentTabUnread", () => {
  it("allows idle agents without attention", () => {
    expect(
      canMarkAgentTabUnread({
        status: "idle",
        requiresAttention: false,
        attentionReason: null,
        pendingPermissions: [],
      }),
    ).toBe(true);
  });

  it("allows closed agents", () => {
    expect(
      canMarkAgentTabUnread({
        status: "closed",
        requiresAttention: false,
      }),
    ).toBe(true);
  });

  it("allows re-marking finished or error attention as unread", () => {
    expect(
      canMarkAgentTabUnread({
        status: "idle",
        requiresAttention: true,
        attentionReason: "finished",
      }),
    ).toBe(true);
    expect(
      canMarkAgentTabUnread({
        status: "idle",
        requiresAttention: true,
        attentionReason: "error",
      }),
    ).toBe(true);
  });

  it("disallows running, pending permission, or archived agents", () => {
    expect(canMarkAgentTabUnread({ status: "running" })).toBe(false);
    expect(
      canMarkAgentTabUnread({
        status: "idle",
        requiresAttention: true,
        attentionReason: "permission",
      }),
    ).toBe(false);
    expect(
      canMarkAgentTabUnread({
        status: "idle",
        pendingPermissions: { size: 1 },
      }),
    ).toBe(false);
    expect(
      canMarkAgentTabUnread({
        status: "idle",
        archivedAt: "2026-10-15T00:00:00.000Z",
      }),
    ).toBe(false);
    expect(canMarkAgentTabUnread(null)).toBe(false);
  });
});

describe("markAgentTabUnread", () => {
  beforeEach(() => {
    getClient.mockReset();
    unfocusPane.mockReset();
    restorePaneFocus.mockReset();
    updateAgent.mockReset();
    unfocusPane.mockReturnValue("token");
    updateAgent.mockResolvedValue(undefined);
    getClient.mockReturnValue({ updateAgent });
    vi.mocked(getHostRuntimeStore).mockReturnValue({
      getClient,
    } as never);
    vi.mocked(useWorkspaceLayoutStore.getState).mockReturnValue(layoutState("tab-1") as never);
  });

  it("unfocuses the current tab before sending the magic label", async () => {
    await markAgentTabUnread({
      serverId: "srv",
      workspaceId: "ws",
      agentId: "agent-1",
      tabId: "tab-1",
    });
    expect(unfocusPane).toHaveBeenCalledWith("srv:ws");
    expect(updateAgent).toHaveBeenCalledWith("agent-1", {
      labels: { [MARK_AGENT_UNREAD_LABEL]: "1" },
    });
    expect(restorePaneFocus).not.toHaveBeenCalled();
  });

  it("does not unfocus a background tab", async () => {
    await markAgentTabUnread({
      serverId: "srv",
      workspaceId: "ws",
      agentId: "agent-1",
      tabId: "tab-other",
    });
    expect(unfocusPane).not.toHaveBeenCalled();
    expect(updateAgent).toHaveBeenCalledTimes(1);
  });

  it("restores pane focus when the unread request fails", async () => {
    updateAgent.mockRejectedValue(new Error("offline"));
    await expect(
      markAgentTabUnread({
        serverId: "srv",
        workspaceId: "ws",
        agentId: "agent-1",
        tabId: "tab-1",
      }),
    ).rejects.toThrow("offline");
    expect(restorePaneFocus).toHaveBeenCalledWith("srv:ws", "token");
  });
});

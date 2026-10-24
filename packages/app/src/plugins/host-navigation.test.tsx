/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { withdrawDaemonSentAgentMessage } from "@/composer/submission/writer";
import { usePluginHostNavigation } from "./host-navigation";
import { showPluginPendingAgentMessage } from "./pending-agent-message";
import { openPluginAgentLaunch } from "./agent-launch";

vi.mock("@/utils/navigate-to-agent", () => ({
  navigateToAgent: vi.fn(),
}));
vi.mock("@/stores/navigation-active-workspace-store", () => ({
  navigateToWorkspace: vi.fn(),
}));
vi.mock("./agent-launch", () => ({
  openPluginAgentLaunch: vi.fn(),
}));
vi.mock("@/composer/submission/writer", () => ({
  withdrawDaemonSentAgentMessage: vi.fn(),
}));
vi.mock("./pending-agent-message", () => ({
  showPluginPendingAgentMessage: vi.fn(),
}));

const navigateToAgentMock = vi.mocked(navigateToAgent);
const navigateToWorkspaceMock = vi.mocked(navigateToWorkspace);
const openPluginAgentLaunchMock = vi.mocked(openPluginAgentLaunch);
const showPluginPendingAgentMessageMock = vi.mocked(showPluginPendingAgentMessage);
const withdrawMock = vi.mocked(withdrawDaemonSentAgentMessage);

describe("usePluginHostNavigation", () => {
  beforeEach(() => {
    navigateToAgentMock.mockReset();
    navigateToWorkspaceMock.mockReset();
    openPluginAgentLaunchMock.mockReset();
    showPluginPendingAgentMessageMock.mockReset();
    showPluginPendingAgentMessageMock.mockResolvedValue(undefined);
    withdrawMock.mockReset();
  });

  it("binds native launches to both the rendering host and plugin", async () => {
    openPluginAgentLaunchMock.mockResolvedValue({
      status: "opened",
      clientInstanceId: "client-1",
      journalVersion: 1,
      submissionState: "editable",
    });
    const { result } = renderHook(() => usePluginHostNavigation("host-1", "plugin-1"));
    const request = {
      launchId: "attempt-1",
      documentIncarnationId: "incarnation-1",
      requestFingerprint: "fingerprint-1",
      projectId: "project-1",
      seedPrompt: "prompt",
      clientMessageId: "message-1",
      labels: { marker: "v1" },
      workspace: { allowExisting: true, allowCreate: true },
    };
    await act(async () => {
      await result.current.openAgentLaunch?.(request);
    });
    expect(openPluginAgentLaunchMock).toHaveBeenCalledWith({
      serverId: "host-1",
      pluginId: "plugin-1",
      request,
    });
  });

  it("opens agents (pinned, so archived ones stay open) and workspaces on the rendering host", () => {
    const { result } = renderHook(() => usePluginHostNavigation("host-1", "plugin-1"));

    act(() => result.current.openAgent({ agentId: "agent-1" }));
    act(() => result.current.openWorkspace({ workspaceId: "workspace-1" }));

    expect(navigateToAgentMock).toHaveBeenCalledWith({
      serverId: "host-1",
      agentId: "agent-1",
      pin: true,
    });
    expect(navigateToWorkspaceMock).toHaveBeenCalledWith({
      serverId: "host-1",
      workspaceId: "workspace-1",
    });
  });

  it("shows a created agent's pending first message on the agent it opens", () => {
    const { result } = renderHook(() => usePluginHostNavigation("host-1", "plugin-1"));
    const message = {
      clientMessageId: "message-1",
      text: "Do the work",
      images: [{ data: "aGk=", mimeType: "image/png" }],
    };

    act(() => result.current.openAgent({ agentId: "agent-1", pendingMessage: message }));

    expect(showPluginPendingAgentMessageMock).toHaveBeenCalledWith({
      serverId: "host-1",
      agentId: "agent-1",
      message,
    });
    expect(navigateToAgentMock).toHaveBeenCalledWith({
      serverId: "host-1",
      agentId: "agent-1",
      pin: true,
    });
  });

  it("withdraws a pending first message on the rendering host", () => {
    const { result } = renderHook(() => usePluginHostNavigation("host-1", "plugin-1"));

    act(() =>
      result.current.withdrawPendingAgentMessage?.({
        agentId: "agent-1",
        clientMessageId: "message-1",
      }),
    );

    expect(withdrawMock).toHaveBeenCalledWith("host-1", "agent-1", "message-1");
  });

  it("keeps the capability stable until the rendering host changes", () => {
    const { result, rerender } = renderHook(
      ({ serverId }) => usePluginHostNavigation(serverId, "plugin-1"),
      {
        initialProps: { serverId: "host-1" },
      },
    );
    const initialNavigation = result.current;

    rerender({ serverId: "host-1" });
    expect(result.current).toBe(initialNavigation);

    rerender({ serverId: "host-2" });
    expect(result.current).not.toBe(initialNavigation);

    act(() => result.current.openAgent({ agentId: "agent-2" }));
    act(() => result.current.openWorkspace({ workspaceId: "workspace-2" }));
    expect(navigateToAgentMock).toHaveBeenCalledWith({
      serverId: "host-2",
      agentId: "agent-2",
      pin: true,
    });
    expect(navigateToWorkspaceMock).toHaveBeenCalledWith({
      serverId: "host-2",
      workspaceId: "workspace-2",
    });
  });
});

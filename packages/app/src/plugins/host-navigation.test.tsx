/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { usePluginHostNavigation } from "./host-navigation";
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

const navigateToAgentMock = vi.mocked(navigateToAgent);
const navigateToWorkspaceMock = vi.mocked(navigateToWorkspace);
const openPluginAgentLaunchMock = vi.mocked(openPluginAgentLaunch);

describe("usePluginHostNavigation", () => {
  beforeEach(() => {
    navigateToAgentMock.mockReset();
    navigateToWorkspaceMock.mockReset();
    openPluginAgentLaunchMock.mockReset();
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

  it("opens agents and workspaces on the rendering host", () => {
    const { result } = renderHook(() => usePluginHostNavigation("host-1", "plugin-1"));

    act(() => result.current.openAgent({ agentId: "agent-1" }));
    act(() => result.current.openWorkspace({ workspaceId: "workspace-1" }));

    expect(navigateToAgentMock).toHaveBeenCalledWith({ serverId: "host-1", agentId: "agent-1" });
    expect(navigateToWorkspaceMock).toHaveBeenCalledWith({
      serverId: "host-1",
      workspaceId: "workspace-1",
    });
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
    expect(navigateToAgentMock).toHaveBeenCalledWith({ serverId: "host-2", agentId: "agent-2" });
    expect(navigateToWorkspaceMock).toHaveBeenCalledWith({
      serverId: "host-2",
      workspaceId: "workspace-2",
    });
  });
});

import { describe, expect, it, vi } from "vitest";
import { openWorkspaceFileInFocusedPane } from "@/screens/workspace/workspace-file-open-command";
import type { WorkspaceFileLocation } from "@/workspace/file-open";

function createInput(closeExplorerAfterOpen: boolean) {
  return {
    location: { path: "src/app.tsx" } as WorkspaceFileLocation,
    persistenceKey: "server:workspace",
    closeExplorerAfterOpen,
    showMobileAgent: vi.fn(),
    openWorkspaceTabInFocusedPane: vi.fn(() => "file-tab"),
    focusWorkspaceTab: vi.fn(),
    requestFileNavigation: vi.fn(),
  };
}

describe("openWorkspaceFileInFocusedPane", () => {
  it("closes the phone overlay after opening a file", () => {
    const input = createInput(true);

    openWorkspaceFileInFocusedPane(input);

    expect(input.showMobileAgent).toHaveBeenCalledOnce();
  });

  it("keeps the tablet dock open after opening a file", () => {
    const input = createInput(false);

    openWorkspaceFileInFocusedPane(input);

    expect(input.showMobileAgent).not.toHaveBeenCalled();
    expect(input.openWorkspaceTabInFocusedPane).toHaveBeenCalledOnce();
    expect(input.focusWorkspaceTab).toHaveBeenCalledWith("server:workspace", "file-tab");
  });

  it("asks for navigation every time, so reopening the same occurrence recentres its pane", () => {
    const input = createInput(false);
    input.location = { path: "src/app.tsx", lineStart: 1201, columnStart: 17 };

    openWorkspaceFileInFocusedPane(input);
    openWorkspaceFileInFocusedPane(input);

    expect(input.requestFileNavigation).toHaveBeenCalledTimes(2);
    expect(input.requestFileNavigation).toHaveBeenLastCalledWith("file-tab");
  });

  it("does not navigate when no tab could be opened", () => {
    const input = { ...createInput(false), openWorkspaceTabInFocusedPane: vi.fn(() => null) };

    openWorkspaceFileInFocusedPane(input);

    expect(input.requestFileNavigation).not.toHaveBeenCalled();
  });
});

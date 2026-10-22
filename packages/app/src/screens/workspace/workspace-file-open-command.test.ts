import { describe, expect, it, vi } from "vitest";
import { openWorkspaceFileFromExplorer } from "@/screens/workspace/workspace-file-open-command";

function createInput(closeExplorerAfterOpen: boolean) {
  return {
    filePath: "src/app.tsx",
    persistenceKey: "server:workspace",
    closeExplorerAfterOpen,
    showMobileAgent: vi.fn(),
    openWorkspaceTabInFocusedPane: vi.fn(() => "file-tab"),
    focusWorkspaceTab: vi.fn(),
  };
}

describe("openWorkspaceFileFromExplorer", () => {
  it("closes the phone overlay after opening a file", () => {
    const input = createInput(true);

    openWorkspaceFileFromExplorer(input);

    expect(input.showMobileAgent).toHaveBeenCalledOnce();
  });

  it("keeps the tablet dock open after opening a file", () => {
    const input = createInput(false);

    openWorkspaceFileFromExplorer(input);

    expect(input.showMobileAgent).not.toHaveBeenCalled();
    expect(input.openWorkspaceTabInFocusedPane).toHaveBeenCalledOnce();
    expect(input.focusWorkspaceTab).toHaveBeenCalledWith("server:workspace", "file-tab");
  });
});

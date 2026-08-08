import { describe, expect, it, vi } from "vitest";
import { openWorkspaceFileFromExplorer } from "@/screens/workspace/workspace-file-open-command";
import { FOCUSED_PANE_PLACEMENT } from "@/stores/workspace-layout-store";

function createInput(
  closeExplorerAfterOpen: boolean,
  extra?: { filePath?: string; lineStart?: number; lineEnd?: number },
) {
  return {
    filePath: extra?.filePath ?? "src/app.tsx",
    lineStart: extra?.lineStart,
    lineEnd: extra?.lineEnd,
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

  it("opens a search match with its target line", () => {
    const input = createInput(true, {
      filePath: "src/search.ts",
      lineStart: 42,
      lineEnd: 42,
    });

    openWorkspaceFileFromExplorer(input);

    expect(input.showMobileAgent).toHaveBeenCalledOnce();
    expect(input.openWorkspaceTabInFocusedPane).toHaveBeenCalledWith(
      "server:workspace",
      {
        kind: "file",
        path: "src/search.ts",
        lineStart: 42,
        lineEnd: 42,
      },
      FOCUSED_PANE_PLACEMENT,
    );
    expect(input.focusWorkspaceTab).toHaveBeenCalledWith("server:workspace", "file-tab");
  });
});

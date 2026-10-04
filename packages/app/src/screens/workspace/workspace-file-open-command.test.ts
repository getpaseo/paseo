import { describe, expect, it, vi } from "vitest";
import { openWorkspaceFileFromExplorer } from "@/screens/workspace/workspace-file-open-command";
import type { WorkspaceTabPlacement } from "@/stores/workspace-layout-store";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";

function createInput(closeExplorerAfterOpen: boolean) {
  return {
    filePath: "src/app.tsx",
    persistenceKey: "server:workspace",
    closeExplorerAfterOpen,
    showMobileAgent: vi.fn(),
    openWorkspaceTabInFocusedPane: vi.fn(
      (_workspaceKey: string, _target: WorkspaceTabTarget, _placement?: WorkspaceTabPlacement) =>
        "file-tab",
    ),
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

  it("decodes a percent-encoded Korean filename before opening it", () => {
    const input = {
      ...createInput(false),
      filePath:
        "D:/workspace/docs/%EC%97%B0%EA%B5%AC%EB%8B%B5%EB%B3%80_%EA%B2%80%EC%A6%9D%EB%B3%B4%EA%B3%A0.md",
    };

    openWorkspaceFileFromExplorer(input);

    expect(input.openWorkspaceTabInFocusedPane.mock.calls[0]?.[1]).toEqual({
      kind: "file",
      path: "D:/workspace/docs/연구답변_검증보고.md",
    });
  });

  it("preserves ASCII-only percent tokens in explorer paths", () => {
    const input = {
      ...createInput(false),
      filePath: "D:/workspace/docs/release%20notes.md",
    };

    openWorkspaceFileFromExplorer(input);

    expect(input.openWorkspaceTabInFocusedPane.mock.calls[0]?.[1]).toEqual({
      kind: "file",
      path: "D:/workspace/docs/release%20notes.md",
    });
  });

  it("keeps malformed percent sequences unchanged", () => {
    const input = {
      ...createInput(false),
      filePath: "D:/workspace/docs/report%ZZ.md",
    };

    openWorkspaceFileFromExplorer(input);

    expect(input.openWorkspaceTabInFocusedPane.mock.calls[0]?.[1]).toEqual({
      kind: "file",
      path: "D:/workspace/docs/report%ZZ.md",
    });
  });

  it.each(["%2F%ED%95%9C", "%5C%ED%95%9C", "%00%ED%95%9C"])(
    "preserves encoded path separators and NUL in %s",
    (encodedSegment) => {
      const input = {
        ...createInput(false),
        filePath: `D:/workspace/docs/${encodedSegment}.md`,
      };

      openWorkspaceFileFromExplorer(input);

      expect(input.openWorkspaceTabInFocusedPane.mock.calls[0]?.[1]).toEqual({
        kind: "file",
        path: `D:/workspace/docs/${encodedSegment}.md`,
      });
    },
  );
});

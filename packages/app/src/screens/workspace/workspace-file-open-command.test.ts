import { describe, expect, it } from "vitest";
import { openWorkspaceFileFromExplorer } from "@/screens/workspace/workspace-file-open-command";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";

function createInput(closeExplorerAfterOpen: boolean) {
  const opened: WorkspaceTabTarget[] = [];
  const focused: string[] = [];
  let closed = 0;
  const input = {
    location: { path: "src/app.tsx", lineStart: 4, columnStart: 2, lineEnd: 4, columnEnd: 8 },
    persistenceKey: "server:workspace",
    closeExplorerAfterOpen,
    showMobileAgent: () => {
      closed++;
    },
    openWorkspaceTabInFocusedPane: (_key: string, target: WorkspaceTabTarget) => {
      opened.push(target);
      return "file-tab";
    },
    focusWorkspaceTab: (key: string, tab: string) => {
      focused.push(`${key}/${tab}`);
    },
  };
  return {
    input,
    opened,
    focused,
    get closed() {
      return closed;
    },
  };
}

describe("openWorkspaceFileFromExplorer", () => {
  it("preserves the selected range and closes the phone overlay after opening a file", () => {
    const fixture = createInput(true);
    openWorkspaceFileFromExplorer(fixture.input);
    expect(fixture.closed).toBe(1);
    expect(fixture.opened).toEqual([{ kind: "file", ...fixture.input.location }]);
    expect(fixture.focused).toEqual(["server:workspace/file-tab"]);
  });

  it("keeps the tablet dock open after opening a file", () => {
    const fixture = createInput(false);
    openWorkspaceFileFromExplorer(fixture.input);
    expect(fixture.closed).toBe(0);
    expect(fixture.opened).toEqual([{ kind: "file", ...fixture.input.location }]);
    expect(fixture.focused).toEqual(["server:workspace/file-tab"]);
  });
});

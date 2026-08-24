import { describe, expect, it } from "vitest";
import { buildWorkspaceKeyboardHandlerId } from "@/keyboard/handler-id";

describe("buildWorkspaceKeyboardHandlerId", () => {
  it("separates workspaces that share a pane id", () => {
    // Every workspace's default pane is called "main", and the deck keeps several
    // workspaces mounted at once. Dropping the workspace id here left the evicted
    // workspace without a keyboard.
    const left = buildWorkspaceKeyboardHandlerId({
      name: "workspace-new-tab-menu",
      serverId: "srv",
      workspaceId: "wks_a",
      paneId: "main",
    });
    const right = buildWorkspaceKeyboardHandlerId({
      name: "workspace-new-tab-menu",
      serverId: "srv",
      workspaceId: "wks_b",
      paneId: "main",
    });

    expect(left).not.toBe(right);
  });

  it("separates panes within a workspace", () => {
    const main = buildWorkspaceKeyboardHandlerId({
      name: "workspace-new-tab-menu",
      serverId: "srv",
      workspaceId: "wks_a",
      paneId: "main",
    });
    const explorer = buildWorkspaceKeyboardHandlerId({
      name: "workspace-new-tab-menu",
      serverId: "srv",
      workspaceId: "wks_a",
      paneId: "explorer",
    });

    expect(main).not.toBe(explorer);
  });

  it("omits the pane segment for workspace-wide surfaces", () => {
    expect(
      buildWorkspaceKeyboardHandlerId({
        name: "workspace-tab-actions",
        serverId: "srv",
        workspaceId: "wks_a",
      }),
    ).toBe("workspace-tab-actions:srv:wks_a");
  });

  it("treats a blank pane id as workspace-wide", () => {
    expect(
      buildWorkspaceKeyboardHandlerId({
        name: "workspace-new-tab-menu",
        serverId: "srv",
        workspaceId: "wks_a",
        paneId: "  ",
      }),
    ).toBe("workspace-new-tab-menu:srv:wks_a");
  });
});

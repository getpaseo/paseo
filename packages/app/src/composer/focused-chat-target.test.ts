import { describe, expect, it } from "vitest";
import type { WorkspaceLayout } from "@/stores/workspace-layout-store";
import { resolveFocusedChatTarget } from "./focused-chat-target";

function layoutWithTarget(
  target: import("@/stores/workspace-tabs-store").WorkspaceTab["target"],
): WorkspaceLayout {
  return {
    root: {
      kind: "pane",
      pane: {
        id: "pane-1",
        tabIds: ["focused-tab"],
        focusedTabId: "focused-tab",
        tabs: [{ tabId: "focused-tab", target, createdAt: 1 }],
      },
    },
    focusedPaneId: "pane-1",
  } as WorkspaceLayout;
}

describe("focused chat target", () => {
  it("targets the focused agent draft", () => {
    expect(
      resolveFocusedChatTarget({
        serverId: "server-1",
        layout: layoutWithTarget({ kind: "agent", agentId: "agent-1" }),
      }),
    ).toEqual({ tabId: "focused-tab", draftKey: "agent:server-1:agent-1" });
  });

  it("targets the focused unsent draft", () => {
    expect(
      resolveFocusedChatTarget({
        serverId: "server-1",
        layout: layoutWithTarget({ kind: "draft", draftId: "draft-1" }),
      }),
    ).toEqual({ tabId: "focused-tab", draftKey: "draft:server-1:draft-1" });
  });

  it("does not guess when the focused tab is not a chat", () => {
    expect(
      resolveFocusedChatTarget({
        serverId: "server-1",
        layout: layoutWithTarget({ kind: "terminal", terminalId: "terminal-1" }),
      }),
    ).toBeNull();
  });
});

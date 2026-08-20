import { describe, expect, it } from "vitest";
import { normalizeLayout, type WorkspaceLayout } from "@/stores/workspace-layout-store";
import { getFocusedAgentId } from "./context";

function layout(target: import("@/workspace-tabs/model").WorkspaceTabTarget): WorkspaceLayout {
  return normalizeLayout({
    focusedPaneId: "main",
    root: {
      kind: "pane",
      pane: {
        id: "main",
        tabIds: ["focused"],
        focusedTabId: "focused",
        tabs: [{ tabId: "focused", target, createdAt: 1 }],
      },
    },
  });
}

describe("plugin Command Center agent context", () => {
  it("uses the focused agent tab", () => {
    expect(getFocusedAgentId(layout({ kind: "agent", agentId: "agent-1" }))).toBe("agent-1");
  });

  it("preserves agent context while its plugin panel is focused", () => {
    expect(
      getFocusedAgentId(
        layout({
          kind: "plugin",
          pluginId: "review",
          panelId: "details",
          context: "agent",
          agentId: "agent-1",
        }),
      ),
    ).toBe("agent-1");
  });

  it("does not invent agent context for workspace panels", () => {
    expect(
      getFocusedAgentId(
        layout({
          kind: "plugin",
          pluginId: "review",
          panelId: "details",
          context: "workspace",
        }),
      ),
    ).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import type { InstalledPlugin } from "../types";
import {
  readPluginDiffPanelState,
  resolvePluginDiffPanel,
  withPluginDiffPanelState,
} from "./model";

function plugin(id: string, serverId: string, panelIds?: string[]): InstalledPlugin {
  return {
    id,
    serverId,
    diffPanels: panelIds?.map((panelId) => ({
      id: panelId,
      title: panelId,
      Component: () => null,
    })),
  } as InstalledPlugin;
}

describe("diff panel ownership", () => {
  it("uses the first contribution in catalog order on the requested host", () => {
    const otherHost = plugin("elsewhere", "other", ["diff"]);
    const noContribution = plugin("files-only", "host");
    const first = plugin("first", "host", ["primary", "secondary"]);
    const second = plugin("second", "host", ["diff"]);
    expect(resolvePluginDiffPanel([otherHost, noContribution, first, second], "host")).toEqual({
      plugin: first,
      contribution: first.diffPanels?.[0],
    });
  });

  it("releases ownership when a contribution or installation disappears", () => {
    const first = plugin("first", "host", ["diff"]);
    const second = plugin("second", "host", ["diff"]);
    first.diffPanels = [];
    expect(resolvePluginDiffPanel([first, second], "host")?.plugin).toBe(second);
    expect(resolvePluginDiffPanel([plugin("other", "other", ["diff"])], "host")).toBeNull();
  });
});

describe("diff panel session state", () => {
  it("keeps changes-pane fields and other plugin sessions when updating one session", () => {
    const original = {
      treeVisible: true,
      treeWidth: 320,
      collapsedFilePaths: ["src/a.ts"],
      pluginDiffPanels: {
        "editor/diff": { sessionId: "old" },
        "other/diff": { sessionId: "other" },
      },
    };
    const updated = withPluginDiffPanelState(original, "editor/diff", { sessionId: "new" });
    expect(updated).toEqual({
      ...original,
      pluginDiffPanels: {
        "editor/diff": { sessionId: "new" },
        "other/diff": { sessionId: "other" },
      },
    });
    expect(readPluginDiffPanelState(updated, "editor/diff")).toEqual({ sessionId: "new" });
    expect(readPluginDiffPanelState(updated, "other/diff")).toEqual({ sessionId: "other" });
    expect(original.pluginDiffPanels["editor/diff"]).toEqual({ sessionId: "old" });
  });

  it("starts without a session and stores opaque JSON for a commit tab", () => {
    expect(readPluginDiffPanelState(undefined, "editor/diff")).toBeUndefined();
    const updated = withPluginDiffPanelState(undefined, "editor/diff", ["session", null, 2]);
    expect(readPluginDiffPanelState(updated, "editor/diff")).toEqual(["session", null, 2]);
    expect(readPluginDiffPanelState(updated, "editor/other")).toBeUndefined();
  });
});

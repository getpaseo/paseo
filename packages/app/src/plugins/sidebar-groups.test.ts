import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { InstalledPlugin } from "./types";
import { groupPluginSidebarContributions } from "./sidebar-groups";

function installed(serverId: string, contributionId = "main"): InstalledPlugin {
  return {
    id: "example",
    cleanup: () => undefined,
    serverId,
    clientBundle: serverId,
    queryClient: new QueryClient(),
    surfaces: [{ id: "surface", Component: () => null }],
    sidebarItems: [
      {
        id: contributionId,
        title: "Example",
        icon: "Blocks",
        surface: "surface",
      },
    ],
    workspacePanels: [],
    commandCenterItems: [],
    attachmentSources: [],
  };
}

describe("groupPluginSidebarContributions", () => {
  it("coalesces the same plugin contribution across hosts", () => {
    const groups = groupPluginSidebarContributions([installed("host-a"), installed("host-b")]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.targets.map((target) => target.plugin.serverId)).toEqual([
      "host-a",
      "host-b",
    ]);
  });

  it("keeps different contribution ids separate", () => {
    const groups = groupPluginSidebarContributions([
      installed("host-a", "main"),
      installed("host-b", "settings"),
    ]);

    expect(groups.map((group) => group.key)).toEqual([
      "example/sidebar/main",
      "example/sidebar/settings",
    ]);
  });
});

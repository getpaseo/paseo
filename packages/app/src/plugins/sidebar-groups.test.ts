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
    clientSlashCommands: [],
    attachmentSources: [],
    themes: [],
    timelineTransformers: [],
    timelineRenderers: [],
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

describe("readPluginSidebarBadge", () => {
  it("sums badge counts across targets and returns null when none contributes", async () => {
    const { readPluginSidebarBadge } = await import("./sidebar-items");
    const badge = (count: number | null) => ({
      getSnapshot: () => count,
      subscribe: () => () => {},
    });
    const target = (count: number | null | undefined) =>
      ({
        plugin: { id: "inbox", serverId: "srv" },
        item: {
          id: "inbox",
          title: "Inbox",
          icon: "Inbox",
          surface: "board",
          ...(count === undefined ? {} : { badge: badge(count) }),
        },
      }) as never;
    const group = (targets: unknown[]) =>
      ({
        key: "inbox/sidebar/inbox",
        pluginId: "inbox",
        contributionId: "inbox",
        title: "Inbox",
        icon: "Inbox",
        targets,
      }) as never;
    expect(readPluginSidebarBadge(group([target(2), target(3), target(undefined)]))).toBe(5);
    expect(readPluginSidebarBadge(group([target(null), target(undefined)]))).toBeNull();
    expect(readPluginSidebarBadge(group([target(0)]))).toBe(0);
  });
});

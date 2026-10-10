import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { InstalledPlugin } from "./types";
import {
  legacySidebarItemHostKey,
  pluginScreensHostKey,
  rememberPluginContributionHost,
} from "./contribution-host";
import { groupPluginSidebarItems, selectPluginSidebarTarget } from "./sidebar-groups";

function installed(
  serverId: string,
  contributionId = "main",
  legacySidebarItems: InstalledPlugin["legacySidebarItems"] = [],
  pluginId = "example",
): InstalledPlugin {
  return {
    id: pluginId,
    cleanup: () => undefined,
    serverId,
    clientBundle: serverId,
    lifetime: new AbortController(),
    queryClient: new QueryClient(),
    paseo: {} as InstalledPlugin["paseo"],
    invoke: async () => undefined,
    settingsScreens: [],
    surfaces: [{ id: "surface", title: "Surface", Component: () => null }],
    sidebarItems: {
      header: [{ id: contributionId, title: "Example", Component: () => null }],
      footer: [{ id: "status", title: "Status", Component: () => null }],
    },
    legacySidebarItems,
    workspacePanels: [],
    commandCenterItems: [],
    clientSlashCommands: [],
    attachmentSources: [],
    themes: [],
    timelineTransformers: [],
    timelineRenderers: [],
    forgeClientProviders: [],
  };
}

describe("groupPluginSidebarItems", () => {
  it("coalesces the same plugin contribution across hosts", () => {
    const groups = groupPluginSidebarItems([installed("host-a"), installed("host-b")], "header");

    expect(groups).toHaveLength(1);
    expect(groups[0]?.targets.map((target) => target.plugin.serverId)).toEqual([
      "host-a",
      "host-b",
    ]);
  });

  it("keeps different contribution ids separate", () => {
    const groups = groupPluginSidebarItems(
      [installed("host-a", "main"), installed("host-b", "settings")],
      "header",
    );

    expect(groups.map((group) => group.key)).toEqual([
      "example/sidebar/main",
      "example/sidebar/settings",
    ]);
  });

  it("keeps a legacy addSidebarItem as its own kind, with its icon, in the header only", () => {
    const legacy = [{ id: "entry", title: "Legacy", icon: "Blocks", surface: "surface" }];
    const plugins = [installed("host-a", "main", legacy), installed("host-b", "main", legacy)];
    const [legacyGroup, itemGroup] = groupPluginSidebarItems(plugins, "header");

    expect(legacyGroup).toMatchObject({ kind: "legacy", title: "Legacy", icon: "Blocks" });
    expect(legacyGroup?.targets.map((target) => target.plugin.serverId)).toEqual([
      "host-a",
      "host-b",
    ]);
    expect(itemGroup?.kind).toBe("item");
    expect(groupPluginSidebarItems(plugins, "footer").map((group) => group.kind)).toEqual(["item"]);
  });

  it("groups only the requested section", () => {
    const groups = groupPluginSidebarItems([installed("host-a")], "footer");

    expect(groups.map((group) => group.key)).toEqual(["example/sidebar-footer/status"]);
  });
});

describe("selectPluginSidebarTarget", () => {
  const legacy = [{ id: "entry", title: "Legacy", icon: "Blocks", surface: "surface" }];

  function hostsOf(section: "header" | "footer", pluginId: string) {
    const plugins = ["host-a", "host-b"].map((serverId) =>
      installed(serverId, "main", legacy, pluginId),
    );
    return groupPluginSidebarItems(plugins, section).map(
      (group) => selectPluginSidebarTarget(group, null).plugin.serverId,
    );
  }

  it("prefers the current route's host", () => {
    const [group] = groupPluginSidebarItems([installed("host-a"), installed("host-b")], "footer");
    expect(selectPluginSidebarTarget(group!, "host-b").plugin.serverId).toBe("host-b");
  });

  it("carries the host picked on any of a plugin's screens to all its items, but not legacy rows", () => {
    expect(hostsOf("header", "screens")).toEqual(["host-a", "host-a"]);
    rememberPluginContributionHost(pluginScreensHostKey("screens"), "host-b");
    // Header: the legacy row keeps its own host; the item follows the screens' host.
    expect(hostsOf("header", "screens")).toEqual(["host-a", "host-b"]);
    expect(hostsOf("footer", "screens")).toEqual(["host-b"]);
    expect(hostsOf("footer", "other")).toEqual(["host-a"]);
  });

  it("keeps a legacy row's host under its own key", () => {
    rememberPluginContributionHost(legacySidebarItemHostKey("legacy-row", "entry"), "host-b");
    expect(hostsOf("header", "legacy-row")).toEqual(["host-b", "host-a"]);
  });
});

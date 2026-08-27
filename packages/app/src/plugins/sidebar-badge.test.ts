import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { InstalledPlugin } from "./types";
import { pluginSidebarBadgeQueryKey, setPluginSidebarBadgeCount } from "./sidebar-badge";

function installedPlugin(): InstalledPlugin {
  return {
    id: "review",
    serverId: "host-a",
    clientBundle: "",
    cleanup() {},
    queryClient: new QueryClient(),
    surfaces: [],
    sidebarItems: [
      {
        id: "inbox",
        title: "Reviews",
        icon: "GitPullRequestArrow",
        surface: "inbox",
        badge: { rpc: {} as never },
      },
    ],
    workspacePanels: [],
    commandCenterItems: [],
    attachmentSources: [],
    themes: [],
  };
}

describe("setPluginSidebarBadgeCount", () => {
  it("updates the mounted badge query immediately", () => {
    const plugin = installedPlugin();

    setPluginSidebarBadgeCount(plugin, "inbox", 0);

    expect(
      plugin.queryClient.getQueryData(
        pluginSidebarBadgeQueryKey(plugin.serverId, plugin.id, "inbox"),
      ),
    ).toEqual({ count: 0 });
  });

  it("rejects an item that did not contribute a badge", () => {
    expect(() => setPluginSidebarBadgeCount(installedPlugin(), "missing", 1)).toThrow(
      /does not have a badge/,
    );
  });
});

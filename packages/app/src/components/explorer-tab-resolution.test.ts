import { describe, expect, it } from "vitest";
import type { InstalledPlugin } from "@getpaseo/protocol/plugin/types";
import { resolveExplorerTab, resolvePluginSidebarTabs } from "@/components/explorer-tab-resolution";

function installedPlugin(input: {
  id: string;
  panels: Array<{ id: string; title?: string; entry?: string }>;
  enabled?: boolean;
  unavailableReason?: string | null;
}): InstalledPlugin {
  return {
    manifest: {
      id: input.id,
      name: `${input.id} plugin`,
      version: "1.0.0",
      contributes: {
        sidebarPanels: input.panels.map((panel) => ({
          id: panel.id,
          title: panel.title ?? panel.id,
          entry: panel.entry ?? `${panel.id}.html`,
        })),
      },
    },
    enabled: input.enabled ?? true,
    installedAt: "2026-02-05T00:00:00.000Z",
    source: { kind: "local" },
    unavailableReason: input.unavailableReason ?? null,
  };
}

const petTabs = resolvePluginSidebarTabs([installedPlugin({ id: "pet", panels: [{ id: "cat" }] })]);
const PET_TAB = "plugin:pet:cat" as const;

describe("resolvePluginSidebarTabs", () => {
  it("orders panels by plugin id and keys each tab by plugin and panel", () => {
    const tabs = resolvePluginSidebarTabs([
      installedPlugin({ id: "zeta", panels: [{ id: "a" }] }),
      installedPlugin({ id: "alpha", panels: [{ id: "b" }, { id: "c" }] }),
    ]);

    expect(tabs.map((tab) => tab.tab)).toEqual([
      "plugin:alpha:b",
      "plugin:alpha:c",
      "plugin:zeta:a",
    ]);
  });

  it("drops a disabled or unavailable plugin's panels", () => {
    const tabs = resolvePluginSidebarTabs([
      installedPlugin({ id: "off", panels: [{ id: "a" }], enabled: false }),
      installedPlugin({ id: "broken", panels: [{ id: "a" }], unavailableReason: "missing entry" }),
    ]);

    expect(tabs).toEqual([]);
  });

  it("keeps only the first of two panels declaring the same id", () => {
    const tabs = resolvePluginSidebarTabs([
      installedPlugin({
        id: "dup",
        panels: [
          { id: "a", title: "first" },
          { id: "a", title: "second" },
        ],
      }),
    ]);

    expect(tabs.map((tab) => tab.title)).toEqual(["first"]);
  });
});

describe("resolveExplorerTab", () => {
  it("renders a plugin tab once its panel is in the list", () => {
    const result = resolveExplorerTab({
      activeTab: PET_TAB,
      isGit: true,
      showPrTab: false,
      pluginTabs: petTabs,
      pluginsLoading: false,
    });

    expect(result.resolvedTab).toBe(PET_TAB);
    expect(result.activePluginTab?.pluginId).toBe("pet");
    expect(result.pluginTabPending).toBe(false);
  });

  // The whole point of the hold: falling back here mounts the Changes pane and
  // fires its git RPCs for the render before the plugin list lands.
  it("holds a remembered plugin tab while the plugin list is still loading", () => {
    const result = resolveExplorerTab({
      activeTab: PET_TAB,
      isGit: true,
      showPrTab: false,
      pluginTabs: [],
      pluginsLoading: true,
    });

    expect(result.resolvedTab).toBe(PET_TAB);
    expect(result.activePluginTab).toBeNull();
    expect(result.pluginTabPending).toBe(true);
  });

  it("falls back once the list has landed without the remembered plugin", () => {
    expect(
      resolveExplorerTab({
        activeTab: PET_TAB,
        isGit: true,
        showPrTab: false,
        pluginTabs: [],
        pluginsLoading: false,
      }),
    ).toEqual({ resolvedTab: "changes", activePluginTab: null, pluginTabPending: false });

    expect(
      resolveExplorerTab({
        activeTab: PET_TAB,
        isGit: false,
        showPrTab: false,
        pluginTabs: [],
        pluginsLoading: false,
      }),
    ).toEqual({ resolvedTab: "files", activePluginTab: null, pluginTabPending: false });
  });

  it("does not hold a built-in tab while the plugin list loads", () => {
    expect(
      resolveExplorerTab({
        activeTab: "changes",
        isGit: true,
        showPrTab: false,
        pluginTabs: [],
        pluginsLoading: true,
      }).resolvedTab,
    ).toBe("changes");
  });

  it("sends changes and pr to files outside a git checkout", () => {
    for (const activeTab of ["changes", "pr"] as const) {
      expect(
        resolveExplorerTab({
          activeTab,
          isGit: false,
          showPrTab: true,
          pluginTabs: petTabs,
          pluginsLoading: false,
        }).resolvedTab,
      ).toBe("files");
    }
  });

  it("sends pr back to changes when there is no pr tab", () => {
    expect(
      resolveExplorerTab({
        activeTab: "pr",
        isGit: true,
        showPrTab: false,
        pluginTabs: petTabs,
        pluginsLoading: false,
      }).resolvedTab,
    ).toBe("changes");
  });
});

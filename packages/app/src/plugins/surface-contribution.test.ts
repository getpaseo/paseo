import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { InstalledPlugin } from "./types";
import {
  getPluginSurfaceContributionServerIds,
  resolvePluginSurfaceContribution,
} from "./surface-contribution";

function installation(
  serverId: string,
  surfaces: string[],
  sidebarItems: Array<{ id: string; surface: string }> = [],
  pluginId = "review",
): InstalledPlugin {
  return {
    id: pluginId,
    serverId,
    clientBundle: serverId,
    queryClient: new QueryClient(),
    cleanup: () => undefined,
    surfaces: surfaces.map((id) => ({ id, Component: () => null })),
    sidebarItems: sidebarItems.map((item) => ({
      ...item,
      title: item.id,
      icon: "Blocks",
    })),
    workspacePanels: [],
    commandCenterItems: [],
    attachmentSources: [],
    themes: [],
  };
}

describe("plugin surface contribution identity", () => {
  const installations = [
    installation(
      "host-v1",
      ["overview", "surface-v1"],
      [{ id: "overview", surface: "surface-v1" }],
    ),
    installation(
      "host-v2",
      ["overview", "surface-v2"],
      [{ id: "overview", surface: "surface-v2" }],
    ),
    installation("same-surface", ["overview"]),
    installation("other-contribution", ["surface-v1"], [{ id: "other", surface: "surface-v1" }]),
    installation(
      "other-plugin",
      ["overview", "surface-v1"],
      [{ id: "overview", surface: "surface-v1" }],
      "other",
    ),
  ];

  it("resolves a sidebar contribution by its explicit identity across host version drift", () => {
    const identity = { kind: "sidebar", id: "overview" } as const;
    const resolved = resolvePluginSurfaceContribution(installations[0] ?? null, identity);

    expect(resolved.sidebarItem?.id).toBe("overview");
    expect(resolved.surface?.id).toBe("surface-v1");
    expect(getPluginSurfaceContributionServerIds(installations, "review", identity)).toEqual([
      "host-v1",
      "host-v2",
    ]);
  });

  it("does not let a same-id sidebar contribution capture a direct surface", () => {
    const identity = { kind: "surface", id: "overview" } as const;
    const resolved = resolvePluginSurfaceContribution(installations[0] ?? null, identity);

    expect(resolved.sidebarItem).toBeNull();
    expect(resolved.surface?.id).toBe("overview");
    expect(getPluginSurfaceContributionServerIds(installations, "review", identity)).toEqual([
      "host-v1",
      "host-v2",
      "same-surface",
    ]);
  });
});

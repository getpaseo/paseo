import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { InstalledPlugin } from "./types";
import {
  currentPluginScreen,
  getPluginSurfaceContributionServerIds,
  parsePluginOpenScreenInput,
  resolvePluginScreenTitle,
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
    lifetime: new AbortController(),
    queryClient: new QueryClient(),
    paseo: {} as InstalledPlugin["paseo"],
    invoke: async () => undefined,
    cleanup: () => undefined,
    settingsScreens: [],
    surfaces: surfaces.map((id) => ({ id, title: id, Component: () => null })),
    sidebarItems: { header: [], footer: [] },
    legacySidebarItems: sidebarItems.map((item) => ({
      ...item,
      title: item.id,
      icon: "Blocks",
    })),
    workspacePanels: [],
    commandCenterItems: [],
    clientSlashCommands: [],
    attachmentSources: [],
    themes: [],
    timelineTransformers: [],
    timelineRenderers: [],
    markdownExtensions: [],
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
      "same-surface",
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

  it("opens a direct screen without borrowing a legacy item that points at it", () => {
    const resolved = resolvePluginSurfaceContribution(installations[0] ?? null, {
      kind: "surface",
      id: "surface-v1",
    });

    expect(resolved.sidebarItem).toBeNull();
    expect(resolved.surface?.id).toBe("surface-v1");
  });

  it("resolves an old sidebar link to the same-id screen once the plugin has migrated", () => {
    const resolved = resolvePluginSurfaceContribution(installations[2] ?? null, {
      kind: "sidebar",
      id: "overview",
    });

    expect(resolved.sidebarItem).toBeNull();
    expect(resolved.surface?.id).toBe("overview");
    expect(
      resolvePluginSurfaceContribution(installations[2] ?? null, { kind: "sidebar", id: "missing" })
        .surface,
    ).toBeNull();
  });
});

describe("currentPluginScreen", () => {
  const plugin = installation(
    "local",
    ["overview", "details"],
    [{ id: "legacy", surface: "details" }],
  );

  it("reads the open screen and its params from direct and legacy routes on the installation's host", () => {
    expect(
      currentPluginScreen(plugin, "/h/local/plugin/review/surface/overview", {
        serverId: "local",
        pluginId: "review",
        contributionKind: "surface",
        contributionId: "overview",
        "param.botId": "bot-2",
      }),
    ).toEqual({ screenId: "overview", params: { botId: "bot-2" } });
    expect(currentPluginScreen(plugin, "/h/local/plugin/review/sidebar/legacy", {})).toEqual({
      screenId: "details",
      params: {},
    });
  });

  it("is null on another host, another plugin, or a missing screen", () => {
    expect(currentPluginScreen(plugin, "/h/remote/plugin/review/surface/overview", {})).toBeNull();
    expect(currentPluginScreen(plugin, "/h/local/plugin/other/surface/overview", {})).toBeNull();
    expect(currentPluginScreen(plugin, "/h/local/plugin/review/surface/missing", {})).toBeNull();
    expect(currentPluginScreen(plugin, "/h/local/workspace/abc", {})).toBeNull();
  });
});

describe("parsePluginOpenScreenInput", () => {
  const plugin = installation("local", ["bot"]);

  it("accepts a registered screen with or without string params, under any key", () => {
    expect(parsePluginOpenScreenInput(plugin, { screenId: "bot" })).toEqual({
      screenId: "bot",
      params: {},
    });
    expect(parsePluginOpenScreenInput(plugin, { screenId: "bot", params: { botId: "2" } })).toEqual(
      { screenId: "bot", params: { botId: "2" } },
    );
    expect(
      parsePluginOpenScreenInput(plugin, { screenId: "bot", params: { serverId: "x" } }),
    ).toEqual({ screenId: "bot", params: { serverId: "x" } });
  });

  it("throws on a bare id, an unknown screen, or params that are not strings", () => {
    expect(() => parsePluginOpenScreenInput(plugin, "bot")).toThrow("{ screenId, params? }");
    expect(() => parsePluginOpenScreenInput(plugin, { screenId: "missing" })).toThrow(
      "unavailable: missing",
    );
    expect(() =>
      parsePluginOpenScreenInput(plugin, { screenId: "bot", params: { botId: 2 } }),
    ).toThrow("botId must be a string");
    expect(() => parsePluginOpenScreenInput(plugin, { screenId: "bot", params: ["2"] })).toThrow(
      "must be an object of strings",
    );
  });
});

describe("resolvePluginScreenTitle", () => {
  const Component = () => null;
  const botNames: Record<string, string> = { "bot-1": "Bot 1", "bot-2": "Bot 2" };
  const bot = {
    id: "bot",
    title: (params: Record<string, string>) => botNames[params.botId] ?? "",
    Component,
  };

  it("uses a string title as is", () => {
    expect(resolvePluginScreenTitle({ id: "deploys", title: "Deploys", Component }, null, {})).toBe(
      "Deploys",
    );
  });

  it("derives a function title from the params it is given", () => {
    expect(resolvePluginScreenTitle(bot, null, { botId: "bot-2" })).toBe("Bot 2");
    expect(resolvePluginScreenTitle(bot, null, { botId: "bot-1" })).toBe("Bot 1");
  });

  it("falls back to the screen id when the function returns empty or throws", () => {
    expect(resolvePluginScreenTitle(bot, null, { botId: "missing" })).toBe("bot");
    const throwing = {
      id: "bot",
      title: () => {
        throw new Error("no bots loaded");
      },
      Component,
    };
    expect(resolvePluginScreenTitle(throwing, null, {})).toBe("bot");
  });

  it("uses the title of a legacy item that points at the screen", () => {
    const legacy = { id: "entry", title: "Legacy entry", icon: "Server", surface: "main" };
    expect(resolvePluginScreenTitle({ id: "main", title: "main", Component }, legacy, {})).toBe(
      "Legacy entry",
    );
  });
});

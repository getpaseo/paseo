import { QueryClient } from "@tanstack/react-query";
import type { PluginThemeContribution } from "@getpaseo/plugin";
import { describe, expect, it } from "vitest";
import { darkTheme, lightTheme } from "@/styles/theme";
import {
  buildPluginTheme,
  collectPluginThemes,
  findPluginTheme,
  rememberPluginThemeHost,
  toPluginTheme,
} from "./theme";
import type { InstalledPlugin } from "./types";

const MOCHA: PluginThemeContribution = {
  id: "mocha",
  name: "Catppuccin Mocha",
  appearance: "dark",
  colors: {
    background: "#1e1e2e",
    foreground: "#cdd6f4",
    raised: "#313244",
    control: "#45475a",
    accent: "#45475a",
    highlight: "#cba6f7",
    mutedForeground: "#a6adc8",
    ring: "#6c7086",
  },
};

const MOCHA_FORK: PluginThemeContribution = {
  ...MOCHA,
  colors: { ...MOCHA.colors, background: "#11111b", highlight: "#f5c2e7" },
};

function installed(serverId: string, themes: PluginThemeContribution[]): InstalledPlugin {
  return {
    id: "catppuccin",
    cleanup: () => undefined,
    serverId,
    clientBundle: serverId,
    queryClient: new QueryClient(),
    surfaces: [],
    sidebarItems: [],
    workspacePanels: [],
    commandCenterItems: [],
    attachmentSources: [],
    themes,
  };
}

describe("toPluginTheme", () => {
  it("maps the app theme into the plugin color tokens", () => {
    expect(toPluginTheme(lightTheme)).toEqual({
      colors: {
        surface0: lightTheme.colors.surface0,
        foreground: lightTheme.colors.foreground,
        foregroundMuted: lightTheme.colors.foregroundMuted,
        accent: lightTheme.colors.accent,
        accentForeground: lightTheme.colors.accentForeground,
        statusDanger: lightTheme.colors.statusDanger,
      },
    });
  });
});

describe("buildPluginTheme", () => {
  it("expands a contributed palette onto the semantic and terminal tokens", () => {
    const theme = buildPluginTheme(MOCHA);

    expect(theme.colorScheme).toBe("dark");
    expect(theme.colors).toMatchObject({
      surface0: "#1e1e2e",
      surface1: "#313244",
      surface2: "#45475a",
      surfaceSidebar: "#1e1e2e",
      foreground: "#cdd6f4",
      foregroundMuted: "#a6adc8",
      border: "#45475a",
      accent: "#cba6f7",
      accentBright: "#cba6f7",
      accentForeground: "#1e1e2e",
      ring: "#6c7086",
      terminal: {
        background: "#1e1e2e",
        foreground: "#cdd6f4",
        cursor: "#cdd6f4",
        cursorAccent: "#1e1e2e",
        black: "#45475a",
        brightBlack: "#6c7086",
      },
    });
  });

  it("carries the accent on the foreground when no highlight is given", () => {
    const { highlight: _highlight, ...colors } = MOCHA.colors;
    const theme = buildPluginTheme({ ...MOCHA, colors });

    expect(theme.colors.accent).toBe("#cdd6f4");
    expect(theme.colors.accentBright).toBe("#cdd6f4");
  });

  it("keeps the status and syntax tokens the built-in dark themes use", () => {
    const theme = buildPluginTheme(MOCHA);

    expect(theme.colors.statusDanger).toBe(darkTheme.colors.statusDanger);
    expect(theme.colors.syntax).toEqual(darkTheme.colors.syntax);
  });
});

const SUPPORTED = new Set(["host-a", "host-b", "host-z"]);

describe("collectPluginThemes", () => {
  it("coalesces the same contribution across hosts", () => {
    const options = collectPluginThemes(
      [installed("host-a", [MOCHA]), installed("host-b", [MOCHA])],
      new Set(["host-a", "host-b"]),
    );

    expect(options.map((option) => option.id)).toEqual(["catppuccin/theme/mocha"]);
  });

  // COMPAT(pluginThemes): a daemon without the capability keeps `addTheme` in the server bundle
  // it compiles, so its themes are not offered at all.
  it("drops themes from a host that predates the pluginThemes capability", () => {
    expect(collectPluginThemes([installed("old-host", [MOCHA])], new Set())).toEqual([]);
  });

  it("keeps themes from the supported host when one peer is too old", () => {
    const options = collectPluginThemes(
      [installed("new-host", [MOCHA]), installed("old-host", [MOCHA])],
      new Set(["new-host"]),
    );

    expect(options.map((option) => option.id)).toEqual(["catppuccin/theme/mocha"]);
  });

  // Two hosts, same plugin and theme id, different palettes. The picked host has to survive a peer
  // connecting or dropping, or the app repaints with no settings change. The remembered host is
  // module state, so this runs the whole sequence in one test rather than leaning on test order.
  it("pins the palette to the picked host across peer connect and disconnect", () => {
    const bothHosts = () =>
      collectPluginThemes(
        [installed("host-a", [MOCHA]), installed("host-z", [MOCHA_FORK])],
        SUPPORTED,
      );

    const beforePick = bothHosts();
    expect(beforePick).toHaveLength(1);
    expect(beforePick[0]?.serverId).toBe("host-a");
    expect(beforePick[0]?.contribution).toBe(MOCHA);

    const onlyHostZ = collectPluginThemes([installed("host-z", [MOCHA_FORK])], SUPPORTED);
    expect(onlyHostZ[0]).toBeDefined();
    rememberPluginThemeHost(onlyHostZ[0]);

    const afterPick = bothHosts();
    expect(afterPick).toHaveLength(1);
    expect(afterPick[0]?.serverId).toBe("host-z");
    expect(afterPick[0]?.contribution).toBe(MOCHA_FORK);

    const withoutHostZ = collectPluginThemes([installed("host-a", [MOCHA])], SUPPORTED);
    expect(withoutHostZ[0]?.serverId).toBe("host-a");
    expect(withoutHostZ[0]?.contribution).toBe(MOCHA);
  });
});

describe("findPluginTheme", () => {
  const supported = new Set(["host-a", "old-host"]);

  it("resolves the persisted selection", () => {
    const options = collectPluginThemes([installed("host-a", [MOCHA])], supported);
    expect(findPluginTheme(options, "catppuccin/theme/mocha")).toBe(MOCHA);
  });

  it("returns null when the plugin is gone so the app falls back to the default theme", () => {
    expect(
      findPluginTheme(collectPluginThemes([], supported), "catppuccin/theme/mocha"),
    ).toBeNull();
  });

  it("returns null when the plugin no longer contributes that theme", () => {
    const options = collectPluginThemes([installed("host-a", [])], supported);
    expect(findPluginTheme(options, "catppuccin/theme/mocha")).toBeNull();
  });

  it("returns null when only an old daemon offers the persisted theme", () => {
    const options = collectPluginThemes([installed("old-host", [MOCHA])], new Set());
    expect(findPluginTheme(options, "catppuccin/theme/mocha")).toBeNull();
  });
});

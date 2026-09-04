import { QueryClient } from "@tanstack/react-query";
import type { PluginThemeContribution } from "@getpaseo/plugin";
import { describe, expect, it } from "vitest";
import { darkTheme, lightTheme } from "@/styles/theme";
import { collectPluginThemes, rememberPluginThemeHost } from "./themes";
import { toPluginTheme } from "./theme";
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
    border: "#45475a",
    accent: "#cba6f7",
    mutedForeground: "#a6adc8",
    ring: "#6c7086",
  },
};

const MOCHA_FORK: PluginThemeContribution = {
  ...MOCHA,
  colors: { ...MOCHA.colors, background: "#11111b", accent: "#f5c2e7" },
};

const LATTE: PluginThemeContribution = {
  id: "latte",
  name: "Catppuccin Latte",
  appearance: "light",
  colors: {
    background: "#eff1f5",
    foreground: "#4c4f69",
    raised: "#e6e9ef",
    control: "#dce0e8",
    border: "#ccd0da",
    accent: "#8839ef",
    mutedForeground: "#6c6f85",
    ring: "#9ca0b0",
  },
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
    clientSlashCommands: [],
    attachmentSources: [],
    themes,
    timelineTransformers: [],
    timelineRenderers: [],
  };
}

describe("toPluginTheme", () => {
  it("maps the app theme into the plugin color tokens", () => {
    expect(toPluginTheme(lightTheme)).toEqual({
      colors: {
        surface0: lightTheme.colors.surface0,
        surface1: lightTheme.colors.surface1,
        surface2: lightTheme.colors.surface2,
        border: lightTheme.colors.border,
        foreground: lightTheme.colors.foreground,
        foregroundMuted: lightTheme.colors.foregroundMuted,
        accent: lightTheme.colors.accent,
        accentForeground: lightTheme.colors.accentForeground,
        statusSuccess: lightTheme.colors.statusSuccess,
        statusWarning: lightTheme.colors.statusWarning,
        statusDanger: lightTheme.colors.statusDanger,
      },
    });
  });
});

describe("plugin theme palettes", () => {
  it("expands a contributed palette onto the semantic and terminal tokens", () => {
    const option = collectPluginThemes([installed("host-a", [MOCHA])], new Set(["host-a"]))[0];
    const theme = option.theme;

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

  it("carries the accent on the foreground when no accent is given", () => {
    const { accent: _accent, ...colors } = MOCHA.colors;
    const contribution = { ...MOCHA, colors };
    const theme = collectPluginThemes([installed("host-a", [contribution])], new Set(["host-a"]))[0]
      .theme;

    expect(theme.colors.accent).toBe("#cdd6f4");
    expect(theme.colors.accentBright).toBe("#cdd6f4");
  });

  it("keeps the status and syntax tokens the built-in dark themes use", () => {
    const theme = collectPluginThemes([installed("host-a", [MOCHA])], new Set(["host-a"]))[0].theme;

    expect(theme.colors.statusDanger).toBe(darkTheme.colors.statusDanger);
    expect(theme.colors.syntax).toEqual(darkTheme.colors.syntax);
  });

  it("derives a complete light theme from the same palette contract", () => {
    const theme = collectPluginThemes([installed("host-a", [LATTE])], new Set(["host-a"]))[0].theme;

    expect(theme.colorScheme).toBe("light");
    expect(theme.colors).toMatchObject({
      surface0: "#eff1f5",
      surface1: "#e6e9ef",
      surface2: "#dce0e8",
      surfaceSidebar: "#dce0e8",
      foreground: "#4c4f69",
      border: "#ccd0da",
      accent: "#8839ef",
      ring: "#9ca0b0",
      terminal: {
        background: "#eff1f5",
        foreground: "#4c4f69",
        black: "#4c4f69",
      },
    });
    expect(theme.colors.statusDanger).toBe(lightTheme.colors.statusDanger);
    expect(theme.colors.syntax).toEqual(lightTheme.colors.syntax);
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
    expect(beforePick[0]?.theme.colors.surface0).toBe("#1e1e2e");

    const onlyHostZ = collectPluginThemes([installed("host-z", [MOCHA_FORK])], SUPPORTED);
    expect(onlyHostZ[0]).toBeDefined();
    rememberPluginThemeHost(onlyHostZ[0]);

    const afterPick = bothHosts();
    expect(afterPick).toHaveLength(1);
    expect(afterPick[0]?.serverId).toBe("host-z");
    expect(afterPick[0]?.theme.colors.surface0).toBe("#11111b");

    const withoutHostZ = collectPluginThemes([installed("host-a", [MOCHA])], SUPPORTED);
    expect(withoutHostZ[0]?.serverId).toBe("host-a");
    expect(withoutHostZ[0]?.theme.colors.surface0).toBe("#1e1e2e");
  });
});

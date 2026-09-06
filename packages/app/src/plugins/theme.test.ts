import { QueryClient } from "@tanstack/react-query";
import type { PluginThemeColorOverrides, PluginThemeContribution } from "@getpaseo/plugin";
import { describe, expect, it } from "vitest";
import { darkTheme, lightTheme } from "@/styles/theme";
import {
  collectPluginThemes,
  parsePluginThemeContribution,
  rememberPluginThemeHost,
} from "./themes";
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

const ALL_OVERRIDES: PluginThemeColorOverrides = {
  surface3: "#010101",
  surface4: "#020202",
  surfaceDiffEmpty: "#030303",
  surfaceSidebar: "#040404",
  surfaceSidebarHover: "#050505",
  surfaceSidebarSelected: "#060606",
  surfaceWorkspace: "#070707",
  interactionHighlight: "#080808cc",
  foregroundExtraMuted: "#090909",
  borderAccent: "#0a0a0a",
  accentBright: "#0b0b0b",
  accentForeground: "#0c0c0c",
  destructive: "#0d0d0d",
  destructiveForeground: "#0e0e0e",
  diffAddition: "#0f0f0f",
  diffDeletion: "#101010",
  statusSuccess: "#111111",
  statusDanger: "#121212",
  statusWarning: "#131313",
  statusMerged: "#141414",
  statusDotSuccess: "#151515",
  statusDotDanger: "#161616",
  statusDotWarning: "#171717",
  statusDotRunning: "#181818",
  terminal: {
    background: "#190101",
    foreground: "#190102",
    cursor: "#190103",
    cursorAccent: "#190104",
    selectionBackground: "#190105cc",
    selectionForeground: "#190106",
    black: "#190107",
    red: "#190108",
    green: "#190109",
    yellow: "#19010a",
    blue: "#19010b",
    magenta: "#19010c",
    cyan: "#19010d",
    white: "#19010e",
    brightBlack: "#19010f",
    brightRed: "#190110",
    brightGreen: "#190111",
    brightYellow: "#190112",
    brightBlue: "#190113",
    brightMagenta: "#190114",
    brightCyan: "#190115",
    brightWhite: "#190116",
  },
};

function installed(serverId: string, themes: PluginThemeContribution[]): InstalledPlugin {
  return {
    id: "catppuccin",
    cleanup: () => undefined,
    serverId,
    clientBundle: serverId,
    queryClient: new QueryClient(),
    settingsScreens: [],
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
  it.each([
    ["dark", MOCHA, darkTheme],
    ["light", LATTE, lightTheme],
  ] as const)(
    "applies every explicit %s semantic override",
    (_appearance, contribution, family) => {
      const overridden = {
        ...contribution,
        colors: { ...contribution.colors, overrides: ALL_OVERRIDES },
      };
      const theme = collectPluginThemes([installed("host-a", [overridden])], new Set(["host-a"]))[0]
        .theme;
      const { terminal, ...semanticOverrides } = ALL_OVERRIDES;

      expect(theme.colors).toMatchObject(semanticOverrides);
      expect(theme.colors.terminal).toMatchObject(terminal ?? {});
      expect(theme.colors.accentBorder).toBe(ALL_OVERRIDES.borderAccent);
      expect(theme.colors.success).toBe(ALL_OVERRIDES.statusSuccess);
      expect(theme.colors.syntax).toEqual(family.colors.syntax);
    },
  );

  it.each([
    {
      appearance: "dark",
      contribution: MOCHA,
      syntax: darkTheme.colors.syntax,
      expected: {
        surface3: "#45475a",
        surface4: "#6c7086",
        surfaceDiffEmpty: "#313244",
        surfaceSidebar: "#1e1e2e",
        surfaceSidebarHover: "#313244",
        surfaceSidebarSelected: "#45475a",
        surfaceWorkspace: "#313244",
        interactionHighlight: darkTheme.colors.interactionHighlight,
        foregroundExtraMuted: "#6c7086",
        borderAccent: "#45475a",
        accentBright: "#cba6f7",
        accentForeground: "#1e1e2e",
        destructive: darkTheme.colors.destructive,
        destructiveForeground: darkTheme.colors.destructiveForeground,
        diffAddition: darkTheme.colors.diffAddition,
        diffDeletion: darkTheme.colors.diffDeletion,
        statusSuccess: darkTheme.colors.statusSuccess,
        statusDanger: darkTheme.colors.statusDanger,
        statusWarning: darkTheme.colors.statusWarning,
        statusMerged: darkTheme.colors.statusMerged,
        statusDotSuccess: darkTheme.colors.statusDotSuccess,
        statusDotDanger: darkTheme.colors.statusDotDanger,
        statusDotWarning: darkTheme.colors.statusDotWarning,
        statusDotRunning: darkTheme.colors.statusDotRunning,
        accentBorder: "#45475a",
        success: "#cba6f7",
        terminal: {
          ...darkTheme.colors.terminal,
          background: "#1e1e2e",
          foreground: "#cdd6f4",
          cursor: "#cdd6f4",
          cursorAccent: "#1e1e2e",
          selectionForeground: "#cdd6f4",
          black: "#45475a",
          brightBlack: "#6c7086",
        },
      },
    },
    {
      appearance: "light",
      contribution: LATTE,
      syntax: lightTheme.colors.syntax,
      expected: {
        surface3: "#ccd0da",
        surface4: "#9ca0b0",
        surfaceDiffEmpty: "#e6e9ef",
        surfaceSidebar: "#dce0e8",
        surfaceSidebarHover: "#e6e9ef",
        surfaceSidebarSelected: "#ccd0da",
        surfaceWorkspace: "#eff1f5",
        interactionHighlight: lightTheme.colors.interactionHighlight,
        foregroundExtraMuted: "#9ca0b0",
        borderAccent: "#ccd0da",
        accentBright: "#8839ef",
        accentForeground: "#eff1f5",
        destructive: lightTheme.colors.destructive,
        destructiveForeground: "#eff1f5",
        diffAddition: lightTheme.colors.diffAddition,
        diffDeletion: lightTheme.colors.diffDeletion,
        statusSuccess: lightTheme.colors.statusSuccess,
        statusDanger: lightTheme.colors.statusDanger,
        statusWarning: lightTheme.colors.statusWarning,
        statusMerged: lightTheme.colors.statusMerged,
        statusDotSuccess: lightTheme.colors.statusDotSuccess,
        statusDotDanger: lightTheme.colors.statusDotDanger,
        statusDotWarning: lightTheme.colors.statusDotWarning,
        statusDotRunning: lightTheme.colors.statusDotRunning,
        accentBorder: "#ccd0da",
        success: "#8839ef",
        terminal: {
          ...lightTheme.colors.terminal,
          background: "#eff1f5",
          foreground: "#4c4f69",
          cursor: "#4c4f69",
          cursorAccent: "#eff1f5",
          selectionForeground: "#4c4f69",
          black: "#4c4f69",
          brightBlack: "#9ca0b0",
        },
      },
    },
  ])(
    "retains every legacy $appearance fallback when overrides are omitted",
    ({ contribution, syntax, expected }) => {
      const theme = collectPluginThemes(
        [installed("host-a", [contribution])],
        new Set(["host-a"]),
      )[0].theme;

      expect(theme.colors).toMatchObject(expected);
      expect(theme.colors.syntax).toEqual(syntax);
    },
  );

  it("carries the accent on the foreground when no accent is given", () => {
    const { accent: _accent, ...colors } = MOCHA.colors;
    const contribution = { ...MOCHA, colors };
    const theme = collectPluginThemes([installed("host-a", [contribution])], new Set(["host-a"]))[0]
      .theme;

    expect(theme.colors.accent).toBe("#cdd6f4");
    expect(theme.colors.accentBright).toBe("#cdd6f4");
  });
});

describe("plugin theme validation", () => {
  it("accepts the original eight-color contribution unchanged", () => {
    expect(parsePluginThemeContribution(MOCHA)).toEqual(MOCHA);
  });

  it("accepts every supported override", () => {
    const contribution = {
      ...MOCHA,
      colors: { ...MOCHA.colors, overrides: ALL_OVERRIDES },
    };

    expect(parsePluginThemeContribution(contribution)).toEqual(contribution);
  });

  it("treats undefined optional overrides as omitted", () => {
    const contribution = parsePluginThemeContribution({
      ...MOCHA,
      colors: {
        ...MOCHA.colors,
        overrides: { surface3: undefined, terminal: { black: undefined } },
      },
    });
    const baseline = collectPluginThemes([installed("host-a", [MOCHA])], new Set(["host-a"]))[0]
      .theme;
    const theme = collectPluginThemes([installed("host-a", [contribution])], new Set(["host-a"]))[0]
      .theme;

    expect(theme).toEqual(baseline);
  });

  it("rejects invalid override colors", () => {
    expect(() =>
      parsePluginThemeContribution({
        ...MOCHA,
        colors: { ...MOCHA.colors, overrides: { surface3: "rebeccapurple" } },
      }),
    ).toThrow("Must be a hex color");
  });

  it.each([
    { ...MOCHA.colors, overrides: { unknownRole: "#ffffff" } },
    { ...MOCHA.colors, overrides: { terminal: { unknownRole: "#ffffff" } } },
  ])("rejects unknown override keys", (colors) => {
    expect(() => parsePluginThemeContribution({ ...MOCHA, colors })).toThrow("Unrecognized key");
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

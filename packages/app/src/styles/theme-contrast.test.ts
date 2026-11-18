import { describe, expect, it } from "vitest";
import type { PluginThemeContribution } from "@getpaseo/plugin";
import { buildPluginTheme } from "@/plugins/themes";
import { contrastRatio } from "@/utils/color";
import { THEME_OPTIONS, type Theme } from "./theme";

// Palettes of the plugin themes users run into: Catppuccin (the e2e fixture) and
// @mousebomb/paseo-solarized 0.1.1, the palette behind issue #7471.
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

const SOLARIZED_LIGHT: PluginThemeContribution = {
  id: "solarized-light",
  name: "Solarized Light",
  appearance: "light",
  colors: {
    background: "#fdf6e3",
    foreground: "#657b83",
    raised: "#eee8d5",
    control: "#eee8d5",
    border: "#e6e0cd",
    accent: "#cb4b16",
    mutedForeground: "#839496",
    ring: "#586e75",
  },
};

const SOLARIZED_DARK: PluginThemeContribution = {
  id: "solarized-dark",
  name: "Solarized Dark",
  appearance: "dark",
  colors: {
    background: "#002b36",
    foreground: "#839496",
    raised: "#073642",
    control: "#073642",
    border: "#073642",
    accent: "#268bd2",
    mutedForeground: "#586e75",
    ring: "#93a1a1",
  },
};

const themes: Array<{ name: string; theme: Theme }> = [
  ...THEME_OPTIONS.flatMap((option) =>
    "theme" in option ? [{ name: option.name, theme: option.theme as Theme }] : [],
  ),
  ...[LATTE, MOCHA, SOLARIZED_LIGHT, SOLARIZED_DARK].map((contribution) => ({
    name: `plugin ${contribution.name}`,
    theme: buildPluginTheme(contribution),
  })),
];

// Contrast floors. A state is a fixed step from the surface it sits on; the built-in Paseo dark
// and Light themes sit at about 1.11/1.25 and 1.15/1.35.
const HOVER_STEP = 1.08;
const SELECTED_STEP = 1.2;
const SELECTED_OVER_HOVER_STEP = 1.04;
// Text on a selected row may cost at most 40% of the legibility the theme gives its own text, and
// never drops below the floor for large UI text.
const SELECTED_TEXT_KEEPS = 0.6;
const SELECTED_TEXT_FLOOR = 2.5;
const NEUTRAL_FILL_STEP = 1.2;
const NEUTRAL_FILL_TEXT_FLOOR = 3;
const TERTIARY_TEXT_FLOOR = 2.5;
// The bright hues are dim on a cream or white background by design; the floor only has to catch a
// color that disappears.
const TERMINAL_COLOR_FLOOR = 1.5;

it("keeps Solarized Dark's selected workspace timestamp readable", () => {
  const { colors } = buildPluginTheme(SOLARIZED_DARK);
  expect(
    contrastRatio(colors.foregroundSidebarSelected, colors.surfaceSidebarSelected),
  ).toBeGreaterThanOrEqual(2.5);
});

describe.each(themes)("$name", ({ theme }) => {
  const colors = theme.colors;

  it("separates a hovered and a selected sidebar row from the sidebar", () => {
    expect(contrastRatio(colors.surfaceSidebar, colors.surfaceSidebarHover)).toBeGreaterThanOrEqual(
      HOVER_STEP,
    );
    expect(
      contrastRatio(colors.surfaceSidebar, colors.surfaceSidebarSelected),
    ).toBeGreaterThanOrEqual(SELECTED_STEP);
    expect(
      contrastRatio(colors.surfaceSidebarHover, colors.surfaceSidebarSelected),
    ).toBeGreaterThanOrEqual(SELECTED_OVER_HOVER_STEP);
  });

  it("keeps the selected row's title readable", () => {
    const onSidebar = contrastRatio(colors.foreground, colors.surfaceSidebar);
    const onSelected = contrastRatio(colors.foreground, colors.surfaceSidebarSelected);
    expect(onSelected).toBeGreaterThanOrEqual(SELECTED_TEXT_FLOOR);
    expect(onSelected).toBeGreaterThanOrEqual(onSidebar * SELECTED_TEXT_KEEPS);
  });

  it("keeps the neutral fill apart from the page and readable under text", () => {
    expect(contrastRatio(colors.surface0, colors.surface3)).toBeGreaterThanOrEqual(
      NEUTRAL_FILL_STEP,
    );
    expect(contrastRatio(colors.foreground, colors.surface3)).toBeGreaterThanOrEqual(
      NEUTRAL_FILL_TEXT_FLOOR,
    );
  });

  it("keeps terminal text readable on the terminal background", () => {
    const terminal = colors.terminal;
    const { background, ...palette } = terminal;
    // The whites and black are fills as often as text, so only the hues are held to a floor.
    for (const key of [
      "red",
      "green",
      "yellow",
      "blue",
      "magenta",
      "cyan",
      "brightRed",
      "brightGreen",
      "brightYellow",
      "brightBlue",
      "brightMagenta",
      "brightCyan",
    ] as const) {
      expect(contrastRatio(background, palette[key]), key).toBeGreaterThanOrEqual(
        TERMINAL_COLOR_FLOOR,
      );
    }
  });
});

describe.each(themes.filter(({ name }) => name.startsWith("plugin ")))(
  "$name derived text",
  ({ theme }) => {
    it("keeps tertiary text readable on the page", () => {
      expect(
        contrastRatio(theme.colors.surface0, theme.colors.foregroundExtraMuted),
      ).toBeGreaterThanOrEqual(TERTIARY_TEXT_FLOOR);
    });
    it("keeps passive text readable on hovered and selected sidebar rows", () => {
      expect(
        contrastRatio(theme.colors.foregroundSidebarHover, theme.colors.surfaceSidebarHover),
      ).toBeGreaterThanOrEqual(TERTIARY_TEXT_FLOOR);
      expect(
        contrastRatio(theme.colors.foregroundSidebarSelected, theme.colors.surfaceSidebarSelected),
      ).toBeGreaterThanOrEqual(TERTIARY_TEXT_FLOOR);
      expect(contrastRatio(theme.colors.surface0, theme.colors.foregroundExtraMuted)).toBeLessThan(
        contrastRatio(theme.colors.surface0, theme.colors.foreground),
      );
    });
  },
);

describe("a plugin theme whose own text is quiet", () => {
  it("still separates the neutral fill from the page", () => {
    const { colors } = buildPluginTheme({
      ...MOCHA,
      colors: { ...MOCHA.colors, background: "#202020", foreground: "#6a6a6a" },
    });
    expect(contrastRatio(colors.surface0, colors.surface3)).toBeGreaterThanOrEqual(
      NEUTRAL_FILL_STEP,
    );
  });
});

describe("a plugin theme with body text between 3:1 and 3.8:1", () => {
  it("keeps the fill visible and lets text on it fall under 3:1", () => {
    const { colors } = buildPluginTheme({
      ...MOCHA,
      colors: { ...MOCHA.colors, background: "#202020", foreground: "#757575" },
    });
    expect(contrastRatio(colors.surface0, colors.foreground)).toBeLessThan(3.8);
    expect(contrastRatio(colors.surface0, colors.surface3)).toBeGreaterThanOrEqual(
      NEUTRAL_FILL_STEP,
    );
    expect(contrastRatio(colors.foreground, colors.surface3)).toBeLessThan(NEUTRAL_FILL_TEXT_FLOOR);
  });
});

describe("built-in themes", () => {
  it.each(themes.filter(({ name }) => !name.startsWith("plugin ")))(
    "$name keeps a control hover visible on the workspace surface",
    ({ theme }) => {
      expect(
        contrastRatio(theme.colors.surfaceWorkspace, theme.colors.surface2),
      ).toBeGreaterThanOrEqual(1.09);
    },
  );
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { darkHighlightColors, resolveSyntaxColors } from "@getpaseo/highlight";
import { DEFAULT_UI_FONT_STACK } from "@/styles/theme";
import { applyAppearance, type AppearanceInput } from "./apply-appearance";

// Override the global react-native-unistyles mock (vitest.setup.ts) so that
// UnistylesRuntime.updateTheme is a spy that records (themeName, updater) calls.
const { updateTheme } = vi.hoisted(() => ({ updateTheme: vi.fn() }));
vi.mock("react-native-unistyles", () => ({ UnistylesRuntime: { updateTheme } }));

// The six registered Unistyles theme keys, in the order applyAppearance patches them.
const ALL_THEME_KEYS = [
  "light",
  "dark",
  "darkZinc",
  "darkMidnight",
  "darkClaude",
  "darkGhostty",
] as const;

// The signature of the updater passed to UnistylesRuntime.updateTheme.
type ThemeUpdater = (theme: FakeTheme) => FakeTheme;

// The subset of the theme shape the updater reads / spreads. The real Theme type
// is a frozen `as const` literal; the updater only touches these fields. Casting a
// fake of this shape through `unknown` to ThemeUpdater's param is test-only.
interface FakeTheme {
  colorScheme: "light" | "dark";
  fontFamily: { ui: string; mono: string };
  fontSize: {
    xs: number;
    code: number;
    sm: number;
    base: number;
    lg: number;
    xl: number;
    "2xl": number;
    "3xl": number;
    "4xl": number;
  };
  lineHeight: { diff: number };
  colors: { foreground: string; syntax: Record<string, string> };
}

function makeFakeTheme(): FakeTheme {
  return {
    colorScheme: "dark",
    fontFamily: { ui: "seed-ui-stack", mono: "seed-mono-stack" },
    fontSize: {
      xs: 12,
      code: 12,
      sm: 14,
      base: 16,
      lg: 18,
      xl: 20,
      "2xl": 22,
      "3xl": 26,
      "4xl": 34,
    },
    lineHeight: { diff: 22 },
    colors: { foreground: "#fff", syntax: {} },
  };
}

function makeInput(overrides: Partial<AppearanceInput> = {}): AppearanceInput {
  return {
    uiFontFamily: "",
    monoFontFamily: "",
    uiFontSize: 16,
    codeFontSize: 12,
    syntaxTheme: "one",
    ...overrides,
  };
}

// Run a single captured updater (default the first) against a fresh fake theme.
function runCapturedUpdater(call = 0): FakeTheme {
  const updater = updateTheme.mock.calls[call]?.[1] as unknown as ThemeUpdater;
  return updater(makeFakeTheme());
}

describe("applyAppearance", () => {
  beforeEach(() => {
    updateTheme.mockClear();
  });

  it("patches every registered Unistyles theme exactly once", () => {
    applyAppearance(makeInput());

    expect(updateTheme).toHaveBeenCalledTimes(6);
    expect(updateTheme.mock.calls.map((call) => call[0])).toEqual([...ALL_THEME_KEYS]);
  });

  it("resolves an empty UI font family to the default stack", () => {
    applyAppearance(makeInput({ uiFontFamily: "" }));

    expect(runCapturedUpdater().fontFamily.ui).toBe(DEFAULT_UI_FONT_STACK);
  });

  it("passes a non-empty UI font family through trimmed", () => {
    applyAppearance(makeInput({ uiFontFamily: "  Menlo  " }));

    expect(runCapturedUpdater().fontFamily.ui).toBe("Menlo");
  });

  it("scales the whole UI ramp proportionally while preserving ratios", () => {
    applyAppearance(makeInput({ uiFontSize: 14 }));

    const { fontSize } = runCapturedUpdater();
    // r = 14 / 16 = 0.875
    expect(fontSize.base).toBe(14); // round(16 * 0.875)
    expect(fontSize.lg).toBe(16); // round(18 * 0.875) = round(15.75)
    expect(fontSize.xs).toBe(11); // round(12 * 0.875) = round(10.5)
    expect(fontSize["4xl"]).toBe(30); // round(34 * 0.875) = round(29.75)
  });

  it("derives the UI ramp from the canonical sizes, not the live theme (no compounding)", () => {
    applyAppearance(makeInput({ uiFontSize: 14 }));

    // Simulate a theme whose fontSize was already scaled by a prior apply; the
    // updater must ignore it and rebuild from the authored FONT_SIZE ramp.
    const updater = updateTheme.mock.calls[0]?.[1] as unknown as ThemeUpdater;
    const alreadyScaled = makeFakeTheme();
    alreadyScaled.fontSize = {
      xs: 4,
      code: 4,
      sm: 4,
      base: 4,
      lg: 4,
      xl: 4,
      "2xl": 4,
      "3xl": 4,
      "4xl": 4,
    };

    const { fontSize } = updater(alreadyScaled);
    expect(fontSize.base).toBe(14); // not 4 * 0.875 — rebuilt from FONT_SIZE
    expect(fontSize.lg).toBe(16);
  });

  it("leaves the UI ramp at authored sizes when only the code size changes", () => {
    applyAppearance(makeInput({ uiFontSize: 16, codeFontSize: 10 }));

    const { fontSize } = runCapturedUpdater();
    expect(fontSize.base).toBe(16);
    expect(fontSize.sm).toBe(14);
    expect(fontSize.code).toBe(10);
  });

  it("sets fontSize.code to codeFontSize regardless of the UI font size", () => {
    applyAppearance(makeInput({ uiFontSize: 14, codeFontSize: 18 }));

    expect(runCapturedUpdater().fontSize.code).toBe(18);
  });

  it("couples lineHeight.diff to the code font size", () => {
    applyAppearance(makeInput({ codeFontSize: 18 }));

    expect(runCapturedUpdater().lineHeight.diff).toBe(Math.round(18 * 1.5)); // 27
  });

  it("swaps colors.syntax to the resolved palette for the named theme", () => {
    applyAppearance(makeInput({ syntaxTheme: "dracula" }));

    const { colors } = runCapturedUpdater();
    expect(colors.syntax).toEqual(resolveSyntaxColors("dracula", "dark"));
  });

  it("resolves a syntax theme using the theme's own color scheme", () => {
    applyAppearance(makeInput({ syntaxTheme: "github" }));

    // makeFakeTheme().colorScheme === "dark" -> github resolves to the dark palette.
    expect(runCapturedUpdater().colors.syntax).toEqual(darkHighlightColors);
    expect(runCapturedUpdater().colors.syntax).toEqual(resolveSyntaxColors("github", "dark"));
  });
});

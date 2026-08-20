import { describe, expect, it } from "vitest";
import { lightTheme } from "@/styles/theme";
import { toPluginTheme } from "./theme";

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

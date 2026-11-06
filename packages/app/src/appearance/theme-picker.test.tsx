/**
 * @vitest-environment jsdom
 */
import React from "react";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginThemeOption } from "@/plugins/themes";
import { lightTheme } from "@/styles/theme";
import { PluginThemeTile } from "./theme-picker";

beforeEach(() => vi.stubGlobal("React", React));

const GREEN_OPTION: PluginThemeOption = {
  id: "plugin/theme/green",
  serverId: "host-a",
  name: "Green",
  swatch: "#40a02b",
  theme: lightTheme,
};

describe("PluginThemeTile", () => {
  it("renders the contributed swatch independently of the theme preview", () => {
    const view = render(
      <PluginThemeTile option={GREEN_OPTION} selected={false} onSelect={vi.fn()} />,
    );

    const swatch = view.getByTestId("theme-picker-swatch");
    expect(swatch.style.backgroundColor).toBe("rgb(64, 160, 43)");
    expect(lightTheme.colors.surface0).not.toBe(GREEN_OPTION.swatch);
  });
});

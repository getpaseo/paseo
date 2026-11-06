import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginThemeOption } from "@/plugins/themes";
import { lightTheme } from "@/styles/theme";
import { PluginThemeTile } from "./theme-tile";

const GREEN_OPTION: PluginThemeOption = {
  id: "plugin/theme/green",
  serverId: "host-a",
  name: "Green",
  swatch: "#40a02b",
  theme: lightTheme,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("React", React);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("PluginThemeTile", () => {
  it("renders the contributed swatch independently of the theme preview", () => {
    act(() => {
      root.render(<PluginThemeTile option={GREEN_OPTION} selected={false} onSelect={vi.fn()} />);
    });

    const swatch = container.querySelector<HTMLElement>('[data-testid="theme-picker-swatch"]');
    expect(swatch).not.toBeNull();
    expect(getComputedStyle(swatch as HTMLElement).backgroundColor).toBe("rgb(64, 160, 43)");
    expect(lightTheme.colors.surface0).not.toBe(GREEN_OPTION.swatch);
  });
});

import { describe, expect, it } from "vitest";
import { pluginButtonMenuOpen, type PluginButtonMenuOpenState } from "./menu-open";

function openMenu(patch: Partial<PluginButtonMenuOpenState> = {}): PluginButtonMenuOpenState {
  return {
    open: true,
    revision: 1,
    nextRevision: 1,
    visible: true,
    disabled: false,
    ...patch,
  };
}

describe("pluginButtonMenuOpen", () => {
  it("stays open when the behavior revision is unchanged", () => {
    expect(pluginButtonMenuOpen(openMenu())).toBe(true);
  });

  it("closes when the behavior revision changes", () => {
    expect(pluginButtonMenuOpen(openMenu({ nextRevision: 2 }))).toBe(false);
  });

  it("closes when the button is hidden", () => {
    expect(pluginButtonMenuOpen(openMenu({ visible: false }))).toBe(false);
  });

  it("closes when the button is disabled", () => {
    expect(pluginButtonMenuOpen(openMenu({ disabled: true }))).toBe(false);
  });
});

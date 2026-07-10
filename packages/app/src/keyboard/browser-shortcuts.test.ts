import { describe, expect, it } from "vitest";
import { buildBrowserShortcutPolicy, parseBrowserShortcutInput } from "./browser-shortcuts";
import { buildEffectiveBindings } from "./keyboard-shortcuts";

describe("buildBrowserShortcutPolicy", () => {
  it("publishes the effective browser page-first shortcut prefixes", () => {
    const bindings = buildEffectiveBindings({
      "workspace-tab-new-ctrl-t-non-mac": "Ctrl+Y",
      "workspace-terminal-new-ctrl-shift-t-non-mac": "Ctrl+F12 Ctrl+F11",
    });

    const policy = buildBrowserShortcutPolicy({ bindings, isMac: false, isDesktop: true });

    expect(policy).toContainEqual({
      alt: false,
      code: "KeyY",
      control: true,
      key: "y",
      meta: false,
      shift: false,
    });
    expect(policy).toContainEqual({
      alt: false,
      code: "F12",
      control: true,
      meta: false,
      shift: false,
    });
    expect(policy).toContainEqual({
      alt: false,
      code: "F11",
      control: true,
      meta: false,
      shift: false,
    });
  });

  it("rejects an entire chord when a continuation cannot cross the browser boundary", () => {
    const bindings = buildEffectiveBindings({
      "settings-toggle-ctrl-comma-non-mac": "Ctrl+F10 F9",
    });

    const policy = buildBrowserShortcutPolicy({ bindings, isMac: false, isDesktop: true });

    expect(policy).not.toContainEqual({
      alt: false,
      code: "F10",
      control: true,
      meta: false,
      shift: false,
    });
    expect(policy).not.toContainEqual({
      alt: false,
      code: "F9",
      control: false,
      meta: false,
      shift: false,
    });
  });

  it("publishes Mod bindings for the current shortcut platform", () => {
    const bindings = buildEffectiveBindings({
      "workspace-tab-new-cmd-t-mac": "Mod+Y",
    });

    expect(buildBrowserShortcutPolicy({ bindings, isMac: true, isDesktop: true })).toContainEqual({
      alt: false,
      code: "KeyY",
      control: false,
      key: "y",
      meta: true,
      shift: false,
    });
  });

  it("does not publish plain browser keys", () => {
    const bindings = buildEffectiveBindings({});
    const policy = buildBrowserShortcutPolicy({ bindings, isMac: false, isDesktop: true });

    expect(policy).not.toContainEqual({
      alt: false,
      code: "Enter",
      control: false,
      meta: false,
      shift: false,
    });
    expect(policy).not.toContainEqual({
      alt: false,
      code: "Slash",
      control: false,
      meta: false,
      shift: true,
    });
  });

  it("publishes Cmd+B with its logical key for non-QWERTY layouts", () => {
    const bindings = buildEffectiveBindings({});
    const policy = buildBrowserShortcutPolicy({ bindings, isMac: true, isDesktop: true });

    expect(policy).toContainEqual({
      alt: false,
      code: "KeyB",
      control: false,
      key: "b",
      meta: true,
      shift: false,
    });
  });

  it("publishes the physical code needed for macOS Option shortcuts", () => {
    const bindings = buildEffectiveBindings({});
    const policy = buildBrowserShortcutPolicy({ bindings, isMac: true, isDesktop: true });

    expect(policy).toContainEqual({
      alt: true,
      code: "KeyT",
      control: false,
      key: "t",
      meta: true,
      shift: false,
    });
  });
});

describe("parseBrowserShortcutInput", () => {
  it("normalizes browser shortcut input without losing its identity", () => {
    expect(
      parseBrowserShortcutInput({
        browserId: "browser-1",
        key: "t",
        code: "KeyT",
        meta: false,
        control: true,
        shift: false,
        alt: false,
      }),
    ).toEqual({
      browserId: "browser-1",
      key: "t",
      code: "KeyT",
      metaKey: false,
      ctrlKey: true,
      shiftKey: false,
      altKey: false,
      repeat: false,
    });
  });

  it.each([
    {
      name: "a missing browser identity",
      payload: {
        key: "t",
        code: "KeyT",
        meta: false,
        control: true,
        shift: false,
        alt: false,
      },
    },
    {
      name: "a malformed repeat flag",
      payload: {
        browserId: "browser-1",
        key: "t",
        code: "KeyT",
        meta: false,
        control: true,
        shift: false,
        alt: false,
        repeat: "yes",
      },
    },
  ])("rejects $name", ({ payload }) => {
    expect(parseBrowserShortcutInput(payload)).toBeNull();
  });
});

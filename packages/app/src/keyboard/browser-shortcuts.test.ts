import { describe, expect, it } from "vitest";
import {
  buildBrowserShortcutPolicy,
  parseBrowserShortcutInput,
  shouldPublishBrowserShortcutPolicy,
} from "./browser-shortcuts";
import { buildEffectiveBindings, resolveKeyboardShortcut } from "./keyboard-shortcuts";

describe("buildBrowserShortcutPolicy", () => {
  it("publishes only chord starts while no browser chord is pending", () => {
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
    expect(policy).not.toContainEqual({
      alt: false,
      code: "F11",
      control: true,
      meta: false,
      shift: false,
    });
  });

  it("publishes a chord continuation only after its browser start crosses the boundary", () => {
    const bindings = buildEffectiveBindings({
      "workspace-terminal-new-ctrl-shift-t-non-mac": "Ctrl+F12 Ctrl+F11",
    });
    const chordIndex = bindings.findIndex(
      (binding) => binding.id === "workspace-terminal-new-ctrl-shift-t-non-mac",
    );

    const policy = buildBrowserShortcutPolicy({
      bindings,
      chordState: { candidateIndices: [chordIndex], step: 1, timeoutId: null },
      isMac: false,
      isDesktop: true,
    });

    expect(policy).toEqual([
      {
        alt: false,
        code: "F11",
        control: true,
        meta: false,
        shift: false,
      },
    ]);

    const result = resolveKeyboardShortcut({
      event: {
        altKey: false,
        code: "F11",
        ctrlKey: true,
        key: "F11",
        metaKey: false,
        repeat: false,
        shiftKey: false,
      },
      context: {
        commandCenterOpen: false,
        focusScope: "browser",
        isDesktop: true,
        isMac: false,
      },
      chordState: { candidateIndices: [chordIndex], step: 1, timeoutId: null },
      onChordReset: () => undefined,
      bindings,
    });

    expect(result.match?.action).toBe("workspace.terminal.new");
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

describe("shouldPublishBrowserShortcutPolicy", () => {
  it("restores the initial browser policy when a host key resets a pending chord", () => {
    expect(
      shouldPublishBrowserShortcutPolicy({
        isBrowserInput: false,
        previousChordState: { candidateIndices: [1], step: 1, timeoutId: null },
        nextChordState: { candidateIndices: [], step: 0, timeoutId: null },
      }),
    ).toBe(true);
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

  it("keeps browser identities exact", () => {
    expect(
      parseBrowserShortcutInput({
        browserId: " browser-1 ",
        key: "t",
        code: "KeyT",
        meta: false,
        control: true,
        shift: false,
        alt: false,
      }),
    ).toMatchObject({ browserId: " browser-1 " });
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

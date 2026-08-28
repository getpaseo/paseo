import { describe, expect, it } from "vitest";
import { buildEffectiveBindings, DEFAULT_BINDINGS } from "./keyboard-shortcuts";
import {
  buildNativeKeyCommands,
  buildNativeOverlayKeyCommands,
  keyboardShortcutInputFromCombo,
  NATIVE_HARDWARE_SHORTCUT_BINDING_IDS,
  TERMINAL_RESERVED_NATIVE_KEY_CODES,
} from "./native-shortcuts";

describe("NATIVE_HARDWARE_SHORTCUT_BINDING_IDS", () => {
  it("names bindings that exist", () => {
    const knownIds = new Set(DEFAULT_BINDINGS.map((binding) => binding.id));
    for (const id of NATIVE_HARDWARE_SHORTCUT_BINDING_IDS) {
      expect(knownIds.has(id), `unknown binding id: ${id}`).toBe(true);
    }
  });

  it("reserves the key of every registered Escape binding for the terminal", () => {
    const escapeBindings = DEFAULT_BINDINGS.filter((binding) => binding.combo === "Escape");
    expect(escapeBindings.length).toBeGreaterThan(0);
    for (const binding of escapeBindings) {
      if (!NATIVE_HARDWARE_SHORTCUT_BINDING_IDS.includes(binding.id)) {
        continue;
      }
      // One un-reserved Escape binding leaves the key registered and the
      // terminal never sees the press, however many others were dropped.
      expect(TERMINAL_RESERVED_NATIVE_KEY_CODES.has(binding.parsedChord[0].code)).toBe(true);
    }
  });
});

describe("buildNativeKeyCommands", () => {
  it("maps the default bindings to UIKeyCommand inputs", () => {
    const commands = buildNativeKeyCommands(buildEffectiveBindings({}));
    expect(commands).toContainEqual({
      combo: "Cmd+N",
      input: "n",
      namedKey: "",
      command: true,
      alternate: false,
      control: false,
      shift: false,
    });
    expect(commands).toContainEqual({
      combo: "Cmd+B",
      input: "b",
      namedKey: "",
      command: true,
      alternate: false,
      control: false,
      shift: false,
    });
    expect(commands).toContainEqual({
      combo: "Cmd+,",
      input: ",",
      namedKey: "",
      command: true,
      alternate: false,
      control: false,
      shift: false,
    });
    expect(commands.map((command) => command.combo)).toEqual([
      "Cmd+N",
      "Cmd+B",
      "Cmd+K",
      "Cmd+P",
      "Cmd+O",
      "Cmd+L",
      "Cmd+,",
      "Escape",
    ]);
  });

  it("sends Escape as a named key for Swift to resolve", () => {
    const commands = buildNativeKeyCommands(buildEffectiveBindings({}));
    expect(commands).toContainEqual({
      combo: "Escape",
      input: "",
      namedKey: "Escape",
      command: false,
      alternate: false,
      control: false,
      shift: false,
    });
  });

  it("registers one command for a key several bindings share", () => {
    // Only one binding carries Escape today, so drive the dedup with an
    // override that puts a second binding on a key another one already has.
    const bindings = buildEffectiveBindings({ "workspace-new-cmd-n-mac": "Cmd+K" });
    const commands = buildNativeKeyCommands(bindings);
    expect(commands.filter((command) => command.combo === "Cmd+K")).toHaveLength(1);
  });

  it("drops every terminal-reserved key while a terminal holds the keyboard", () => {
    const commands = buildNativeKeyCommands(buildEffectiveBindings({}), {
      isTerminalFocused: true,
    });
    expect(commands.map((command) => command.combo)).not.toContain("Escape");
    // Everything the terminal does not need stays registered.
    expect(commands.map((command) => command.combo)).toContain("Cmd+K");
  });

  it("drops a named key iOS has no constant for", () => {
    const bindings = buildEffectiveBindings({ "workspace-new-cmd-n-mac": "Backspace" });
    const combos = buildNativeKeyCommands(bindings).map((command) => command.combo);
    expect(combos).not.toContain("Backspace");
  });

  it("registers the rebound combo, not the shipped one", () => {
    const bindings = buildEffectiveBindings({ "workspace-new-cmd-n-mac": "Cmd+Shift+M" });
    const commands = buildNativeKeyCommands(bindings);
    expect(commands).toContainEqual({
      combo: "Cmd+Shift+M",
      input: "m",
      namedKey: "",
      command: true,
      alternate: false,
      control: false,
      shift: true,
    });
  });

  it("drops a binding the user unassigned", () => {
    const bindings = buildEffectiveBindings({ "sidebar-toggle-left-mac-cmd-b": null });
    const combos = buildNativeKeyCommands(bindings).map((command) => command.combo);
    expect(combos).not.toContain("Cmd+B");
  });

  it("drops a chord, which UIKeyCommand cannot express", () => {
    const bindings = buildEffectiveBindings({ "workspace-new-cmd-n-mac": "Cmd+K Cmd+N" });
    const combos = buildNativeKeyCommands(bindings).map((command) => command.combo);
    expect(combos).not.toContain("Cmd+K Cmd+N");
  });
});

describe("buildNativeOverlayKeyCommands", () => {
  it("registers the keys an overlay asked for under their bare names", () => {
    expect(buildNativeOverlayKeyCommands(["ArrowUp", "Enter"])).toEqual([
      {
        combo: "ArrowUp",
        input: "",
        namedKey: "ArrowUp",
        command: false,
        alternate: false,
        control: false,
        shift: false,
      },
      {
        combo: "Enter",
        input: "",
        namedKey: "Enter",
        command: false,
        alternate: false,
        control: false,
        shift: false,
      },
    ]);
  });

  it("refuses a key that is not overlay-registerable", () => {
    // Backspace would stop the search field deleting text, and Escape is
    // already registered for `agent.interrupt`.
    expect(buildNativeOverlayKeyCommands(["Backspace", "Escape", "KeyA"])).toEqual([]);
  });

  it("registers a repeated key once", () => {
    expect(buildNativeOverlayKeyCommands(["Enter", "Enter"])).toHaveLength(1);
  });
});

describe("keyboardShortcutInputFromCombo", () => {
  it("rebuilds the key event the resolver expects", () => {
    expect(keyboardShortcutInputFromCombo("Cmd+N")).toEqual({
      key: "n",
      code: "KeyN",
      altKey: false,
      ctrlKey: false,
      metaKey: true,
      shiftKey: false,
      repeat: false,
    });
  });

  it("carries every modifier", () => {
    expect(keyboardShortcutInputFromCombo("Cmd+Alt+Shift+O")).toMatchObject({
      key: "o",
      code: "KeyO",
      altKey: true,
      metaKey: true,
      shiftKey: true,
    });
  });

  it("rebuilds a named key on its code", () => {
    expect(keyboardShortcutInputFromCombo("Escape")).toEqual({
      key: "Escape",
      code: "Escape",
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      repeat: false,
    });
  });

  it("returns null for a combo it cannot rebuild", () => {
    expect(keyboardShortcutInputFromCombo("Cmd+Digit")).toBeNull();
    expect(keyboardShortcutInputFromCombo("Cmd+K Cmd+N")).toBeNull();
    expect(keyboardShortcutInputFromCombo("nonsense")).toBeNull();
    expect(keyboardShortcutInputFromCombo("Backspace")).toBeNull();
  });
});

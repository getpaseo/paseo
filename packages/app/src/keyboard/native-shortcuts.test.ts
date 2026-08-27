import { describe, expect, it } from "vitest";
import { buildEffectiveBindings, DEFAULT_BINDINGS } from "./keyboard-shortcuts";
import {
  buildNativeKeyCommands,
  keyboardShortcutInputFromCombo,
  NATIVE_HARDWARE_SHORTCUT_BINDING_IDS,
} from "./native-shortcuts";

describe("NATIVE_HARDWARE_SHORTCUT_BINDING_IDS", () => {
  it("names bindings that exist", () => {
    const knownIds = new Set(DEFAULT_BINDINGS.map((binding) => binding.id));
    for (const id of NATIVE_HARDWARE_SHORTCUT_BINDING_IDS) {
      expect(knownIds.has(id), `unknown binding id: ${id}`).toBe(true);
    }
  });

  it("only names bindings iOS can serve, which excludes Escape", () => {
    const escapeBindings = DEFAULT_BINDINGS.filter((binding) => binding.combo === "Escape");
    expect(escapeBindings.length).toBeGreaterThan(0);
    for (const binding of escapeBindings) {
      expect(NATIVE_HARDWARE_SHORTCUT_BINDING_IDS).not.toContain(binding.id);
    }
  });
});

describe("buildNativeKeyCommands", () => {
  it("maps the default bindings to UIKeyCommand inputs", () => {
    const commands = buildNativeKeyCommands(buildEffectiveBindings({}));
    expect(commands).toContainEqual({
      combo: "Cmd+N",
      input: "n",
      command: true,
      alternate: false,
      control: false,
      shift: false,
    });
    expect(commands).toContainEqual({
      combo: "Cmd+B",
      input: "b",
      command: true,
      alternate: false,
      control: false,
      shift: false,
    });
    expect(commands).toContainEqual({
      combo: "Cmd+,",
      input: ",",
      command: true,
      alternate: false,
      control: false,
      shift: false,
    });
    expect(commands).toHaveLength(NATIVE_HARDWARE_SHORTCUT_BINDING_IDS.length);
  });

  it("registers the rebound combo, not the shipped one", () => {
    const bindings = buildEffectiveBindings({ "workspace-new-cmd-n-mac": "Cmd+Shift+M" });
    const commands = buildNativeKeyCommands(bindings);
    expect(commands).toContainEqual({
      combo: "Cmd+Shift+M",
      input: "m",
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

  it("returns null for a combo it cannot rebuild", () => {
    expect(keyboardShortcutInputFromCombo("Cmd+Digit")).toBeNull();
    expect(keyboardShortcutInputFromCombo("Cmd+K Cmd+N")).toBeNull();
    expect(keyboardShortcutInputFromCombo("nonsense")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { formatShortcut } from "@/utils/format-shortcut";
import {
  comboStringToShortcutKeys,
  keyComboToString,
  keyboardEventToComboString,
  parseShortcutString,
  SHORTCUT_KEY_NAMES,
} from "./shortcut-string";

function keyboardEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: "",
    code: "",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    ...overrides,
  } as KeyboardEvent;
}

describe("keyboardEventToComboString", () => {
  it("captures the minus key (regression: previously returned null)", () => {
    expect(keyboardEventToComboString(keyboardEvent({ key: "-", code: "Minus" }))).toBe("-");
  });

  it("captures minus with modifiers", () => {
    expect(
      keyboardEventToComboString(keyboardEvent({ key: "-", code: "Minus", metaKey: true })),
    ).toBe("Cmd+-");
    expect(
      keyboardEventToComboString(keyboardEvent({ key: "_", code: "Minus", shiftKey: true })),
    ).toBe("Shift+-");
  });

  it("captures equal, semicolon, and quote", () => {
    expect(keyboardEventToComboString(keyboardEvent({ key: "=", code: "Equal" }))).toBe("=");
    expect(keyboardEventToComboString(keyboardEvent({ key: ";", code: "Semicolon" }))).toBe(";");
    expect(keyboardEventToComboString(keyboardEvent({ key: "'", code: "Quote" }))).toBe("'");
  });

  it("still returns null for modifier-only presses", () => {
    expect(keyboardEventToComboString(keyboardEvent({ code: "ShiftLeft" }))).toBeNull();
  });
});

describe("parseShortcutString round-trips punctuation keys", () => {
  const cases: ReadonlyArray<[string, string, string, string]> = [
    ["-", "Minus", "-", "_"],
    ["=", "Equal", "=", "+"],
    [";", "Semicolon", ";", ":"],
    ["'", "Quote", "'", '"'],
  ];

  for (const [humanKey, code, key, shiftedKey] of cases) {
    it(`round-trips ${humanKey}`, () => {
      const combo = parseShortcutString(humanKey);
      expect(combo.code).toBe(code);
      expect(combo.key).toBe(key);
      expect(combo.shiftedKey).toBe(shiftedKey);
      expect(keyComboToString(combo)).toBe(humanKey);
    });
  }

  it("round-trips a modifier combo with minus", () => {
    const combo = parseShortcutString("Cmd+-");
    expect(combo.meta).toBe(true);
    expect(combo.code).toBe("Minus");
    expect(keyComboToString(combo)).toBe("Cmd+-");
  });
});

describe("comboStringToShortcutKeys", () => {
  it("maps every modifier spelling onto its display token", () => {
    expect(comboStringToShortcutKeys("Cmd+Ctrl+Alt+Shift+K")).toEqual([
      "mod",
      "ctrl",
      "alt",
      "shift",
      "K",
    ]);
    // `parseShortcutString` accepts `Mod` as well, so the display path has to.
    expect(comboStringToShortcutKeys("Mod+K")).toEqual(["mod", "K"]);
  });

  it("hands named keys to the display table under the names it uses", () => {
    expect(comboStringToShortcutKeys("Cmd+Shift+ArrowLeft")).toEqual(["mod", "shift", "Left"]);
    expect(formatShortcut(comboStringToShortcutKeys("Cmd+Shift+ArrowLeft"), "mac")).toBe(
      "Shift+⌘+←",
    );
    expect(formatShortcut(comboStringToShortcutKeys("Escape"), "mac")).toBe("Esc");
    expect(formatShortcut(comboStringToShortcutKeys("Backspace"), "mac")).toBe("⌫");
  });

  // The whole class, not just the arrows: uppercasing key names used to push
  // every multi-character name past `KEY_DISPLAY`, so an override on one of them
  // rendered as a shouty raw code — `ARROWLEFT`, `ESCAPE`, `PAGEDOWN`.
  it("never emits a shouty raw code for any key the capture path can produce", () => {
    for (const name of SHORTCUT_KEY_NAMES) {
      // `F1` and the digits are already all-caps, so only names that contain a
      // lowercase letter can exhibit the bug.
      if (name === name.toUpperCase()) continue;
      const [key] = comboStringToShortcutKeys(name);
      const rendered = formatShortcut([key], "non-mac");
      expect(rendered, `${name} renders as ${rendered}`).not.toBe(name.toUpperCase());
    }
  });
});

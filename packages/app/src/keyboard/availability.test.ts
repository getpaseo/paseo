import { describe, expect, it } from "vitest";
import { dispatchableShortcutBindings, keyboardShortcutsAvailable } from "./availability";

describe("keyboardShortcutsAvailable", () => {
  it("matches the environments where the shortcut dispatcher runs", () => {
    expect(keyboardShortcutsAvailable({ isNative: false, isCompact: false })).toBe(true);
    expect(keyboardShortcutsAvailable({ isNative: false, isCompact: true })).toBe(false);
    expect(keyboardShortcutsAvailable({ isNative: true, isCompact: false })).toBe(false);
    expect(keyboardShortcutsAvailable({ isNative: true, isCompact: true })).toBe(false);
  });
});

describe("dispatchableShortcutBindings", () => {
  const bindings = [
    { id: "everywhere-but-compact" },
    { id: "compact-too", compact: true as const },
  ];

  it("dispatches every binding on wide web", () => {
    expect(dispatchableShortcutBindings(bindings, { isNative: false, isCompact: false })).toEqual(
      bindings,
    );
  });

  it("dispatches only the compact bindings on compact web", () => {
    expect(
      dispatchableShortcutBindings(bindings, { isNative: false, isCompact: true }).map(
        (binding) => binding.id,
      ),
    ).toEqual(["compact-too"]);
  });

  it("dispatches nothing on native, compact or not", () => {
    expect(dispatchableShortcutBindings(bindings, { isNative: true, isCompact: false })).toEqual(
      [],
    );
    expect(dispatchableShortcutBindings(bindings, { isNative: true, isCompact: true })).toEqual([]);
  });
});

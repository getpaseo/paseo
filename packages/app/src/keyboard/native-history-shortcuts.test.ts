import { describe, expect, it } from "vitest";
import {
  buildNativeHistoryBindings,
  buildNativeHistoryCommands,
  buildNativeShortcutCaptureCommands,
} from "./native-history-shortcuts";
import { resolveKeyboardShortcut } from "./keyboard-shortcuts";
import { keyboardEventToComboString } from "./shortcut-string";

describe("native history shortcuts", () => {
  it("only registers configured history keys, leaving other app shortcuts alone", () => {
    const bindings = buildNativeHistoryBindings({
      "navigation-history-back": "Mod+ArrowLeft",
      "navigation-history-forward": null,
      "command-center": "Mod+K",
    });
    const commands = buildNativeHistoryCommands(bindings, { candidateIndices: [], step: 0 });
    expect(commands).toEqual([
      {
        key: "ArrowLeft",
        code: "ArrowLeft",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        repeat: false,
      },
    ]);
    const result = resolveKeyboardShortcut({
      event: commands[0],
      bindings,
      context: { isMac: true, isDesktop: false, focusScope: "other", commandCenterOpen: false },
      chordState: { candidateIndices: [], step: 0, timeoutId: null },
      onChordReset() {},
    });
    expect(result.match?.action).toBe("navigation.history.back");
  });

  it("does not intercept unmodified chord suffixes until their prefix was pressed", () => {
    const bindings = buildNativeHistoryBindings({ "navigation-history-back": "Cmd+K A" });
    expect(
      buildNativeHistoryCommands(bindings, { candidateIndices: [], step: 0 }).map(
        (key) => key.code,
      ),
    ).toEqual(["KeyK"]);
    expect(
      buildNativeHistoryCommands(bindings, { candidateIndices: [0], step: 1 }).map(
        (key) => key.code,
      ),
    ).toEqual(["KeyA"]);
  });

  it("captures modified hardware keys in the shared override format", () => {
    const command = buildNativeShortcutCaptureCommands().find(
      (key) =>
        key.code === "ArrowLeft" && key.metaKey && key.altKey && !key.ctrlKey && !key.shiftKey,
    );
    expect(command).toEqual({
      key: "ArrowLeft",
      code: "ArrowLeft",
      metaKey: true,
      altKey: true,
      ctrlKey: false,
      shiftKey: false,
      repeat: false,
    });
    expect(keyboardEventToComboString(command!)).toBe("Alt+Cmd+ArrowLeft");
  });
});

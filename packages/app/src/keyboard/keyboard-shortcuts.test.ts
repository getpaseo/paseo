import { describe, expect, it } from "vitest";
import {
  buildKeyboardShortcutHelpSections,
  resolveKeyboardShortcut,
  type KeyboardShortcutContext,
} from "./keyboard-shortcuts";

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

function shortcutContext(
  overrides: Partial<KeyboardShortcutContext> = {}
): KeyboardShortcutContext {
  return {
    isMac: false,
    isTauri: false,
    focusScope: "other",
    commandCenterOpen: false,
    hasSelectedAgent: true,
    ...overrides,
  };
}

describe("keyboard-shortcuts", () => {
  it("matches question-mark shortcut to toggle the shortcuts dialog", () => {
    const match = resolveKeyboardShortcut({
      event: keyboardEvent({
        key: "?",
        code: "Slash",
        shiftKey: true,
      }),
      context: shortcutContext({ focusScope: "other" }),
    });

    expect(match?.action).toBe("shortcuts.dialog.toggle");
  });

  it("does not match question-mark shortcut inside editable scopes", () => {
    const match = resolveKeyboardShortcut({
      event: keyboardEvent({
        key: "?",
        code: "Slash",
        shiftKey: true,
      }),
      context: shortcutContext({ focusScope: "message-input" }),
    });

    expect(match).toBeNull();
  });

  it("matches Cmd+B sidebar toggle on macOS", () => {
    const match = resolveKeyboardShortcut({
      event: keyboardEvent({
        key: "b",
        code: "KeyB",
        metaKey: true,
      }),
      context: shortcutContext({ isMac: true }),
    });

    expect(match?.action).toBe("sidebar.toggle.left");
  });

  it("does not bind Ctrl+B on non-mac", () => {
    const match = resolveKeyboardShortcut({
      event: keyboardEvent({
        key: "b",
        code: "KeyB",
        ctrlKey: true,
      }),
      context: shortcutContext({ isMac: false }),
    });

    expect(match).toBeNull();
  });

  it("keeps Mod+. as sidebar toggle fallback", () => {
    const match = resolveKeyboardShortcut({
      event: keyboardEvent({
        key: ".",
        code: "Period",
        ctrlKey: true,
      }),
      context: shortcutContext({ isMac: false }),
    });

    expect(match?.action).toBe("sidebar.toggle.left");
  });

  it("routes Mod+D to message-input action outside terminal", () => {
    const match = resolveKeyboardShortcut({
      event: keyboardEvent({
        key: "d",
        code: "KeyD",
        metaKey: true,
      }),
      context: shortcutContext({ isMac: true, focusScope: "message-input" }),
    });

    expect(match?.action).toBe("message-input.action");
    expect(match?.payload).toEqual({ kind: "dictation-toggle" });
  });

  it("does not route message-input actions when terminal is focused", () => {
    const match = resolveKeyboardShortcut({
      event: keyboardEvent({
        key: "d",
        code: "KeyD",
        metaKey: true,
      }),
      context: shortcutContext({ isMac: true, focusScope: "terminal" }),
    });

    expect(match).toBeNull();
  });

  it("keeps space typing available in message input", () => {
    const match = resolveKeyboardShortcut({
      event: keyboardEvent({
        key: " ",
        code: "Space",
      }),
      context: shortcutContext({ focusScope: "message-input" }),
    });

    expect(match).toBeNull();
  });

  it("routes space to voice mute toggle outside editable scopes", () => {
    const match = resolveKeyboardShortcut({
      event: keyboardEvent({
        key: " ",
        code: "Space",
      }),
      context: shortcutContext({ focusScope: "other" }),
    });

    expect(match?.action).toBe("message-input.action");
    expect(match?.payload).toEqual({ kind: "voice-mute-toggle" });
  });

  it("lets Escape continue to local handlers while routing dictation cancel", () => {
    const match = resolveKeyboardShortcut({
      event: keyboardEvent({
        key: "Escape",
        code: "Escape",
      }),
      context: shortcutContext({ focusScope: "message-input" }),
    });

    expect(match?.action).toBe("message-input.action");
    expect(match?.payload).toEqual({ kind: "dictation-cancel" });
    expect(match?.preventDefault).toBe(false);
    expect(match?.stopPropagation).toBe(false);
  });

  it("parses Alt+digit sidebar shortcut payload", () => {
    const match = resolveKeyboardShortcut({
      event: keyboardEvent({
        key: "2",
        code: "Digit2",
        altKey: true,
      }),
      context: shortcutContext(),
    });

    expect(match?.action).toBe("sidebar.navigate.shortcut");
    expect(match?.payload).toEqual({ digit: 2 });
  });
});

describe("keyboard-shortcut help sections", () => {
  function findRow(
    sections: ReturnType<typeof buildKeyboardShortcutHelpSections>,
    id: string
  ) {
    for (const section of sections) {
      const row = section.rows.find((candidate) => candidate.id === id);
      if (row) {
        return row;
      }
    }
    return null;
  }

  it("uses non-tauri defaults for new-agent and quick-open", () => {
    const sections = buildKeyboardShortcutHelpSections({
      isMac: true,
      isTauri: false,
    });

    expect(findRow(sections, "new-agent")?.keys).toEqual(["mod", "alt", "N"]);
    expect(findRow(sections, "quick-open-agent")?.keys).toEqual([
      "alt",
      "1-9",
    ]);
  });

  it("switches to tauri bindings in help rows", () => {
    const sections = buildKeyboardShortcutHelpSections({
      isMac: true,
      isTauri: true,
    });

    expect(findRow(sections, "new-agent")?.keys).toEqual(["mod", "N"]);
    expect(findRow(sections, "quick-open-agent")?.keys).toEqual([
      "mod",
      "1-9",
    ]);
  });

  it("uses mod+period as non-mac left sidebar shortcut", () => {
    const sections = buildKeyboardShortcutHelpSections({
      isMac: false,
      isTauri: false,
    });

    expect(findRow(sections, "toggle-left-sidebar")?.keys).toEqual([
      "mod",
      ".",
    ]);
  });
});

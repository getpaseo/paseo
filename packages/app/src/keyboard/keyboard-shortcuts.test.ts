import { describe, expect, it, vi } from "vitest";
import { formatShortcut } from "@/utils/format-shortcut";
import {
  buildKeyboardShortcutHelpSections,
  buildEffectiveBindings,
  getBindingIdForAction,
  getDefaultKeysForAction,
  getWorkspaceIndexJumpModifierKey,
  parseBindingChord,
  resolveKeyboardShortcut,
  resolveShortcutKeysForAction,
  SHORTCUT_HELP_ROW_ORDER,
  UNASSIGNED_COMBO,
  type ChordState,
  type KeyboardShortcutContext,
  type KeyboardShortcutInput,
  type ParsedShortcutBinding,
  type ShortcutOverrides,
} from "./keyboard-shortcuts";

function keyboardInput(overrides: Partial<KeyboardShortcutInput>): KeyboardShortcutInput {
  return {
    key: "",
    code: "",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    ...overrides,
  };
}

function shortcutContext(
  overrides: Partial<KeyboardShortcutContext> = {},
): KeyboardShortcutContext {
  return {
    isMac: false,
    isDesktop: false,
    focusScope: "other",
    commandCenterOpen: false,
    ...overrides,
  };
}

function initialChordState(): ChordState {
  return {
    candidateIndices: [],
    step: 0,
    timeoutId: null,
  };
}

function resolveShortcut(input: {
  event: Partial<KeyboardShortcutInput>;
  context?: Partial<KeyboardShortcutContext>;
  chordState?: ChordState;
  onChordReset?: () => void;
  bindings?: readonly ParsedShortcutBinding[];
}) {
  return resolveKeyboardShortcut({
    event: keyboardInput(input.event),
    context: shortcutContext(input.context),
    chordState: input.chordState ?? initialChordState(),
    onChordReset: input.onChordReset ?? (() => undefined),
    ...(input.bindings ? { bindings: input.bindings } : {}),
  });
}

function expectShortcutResolution(input: {
  event: Partial<KeyboardShortcutInput>;
  context?: Partial<KeyboardShortcutContext>;
  action: string;
  payload?: unknown;
  preventDefault?: boolean;
  stopPropagation?: boolean;
}) {
  const result = resolveShortcut({
    event: input.event,
    context: input.context,
  });

  expect(result.match?.action).toBe(input.action);
  if ("payload" in input) {
    expect(result.match?.payload).toEqual(input.payload);
  }
  expect(result.match?.preventDefault).toBe(input.preventDefault ?? true);
  expect(result.match?.stopPropagation).toBe(input.stopPropagation ?? true);
  expect(result.preventDefault).toBe(false);
  expect(result.nextChordState).toEqual(initialChordState());
}

function expectNoShortcutResolution(input: {
  event: Partial<KeyboardShortcutInput>;
  context?: Partial<KeyboardShortcutContext>;
}) {
  const result = resolveShortcut({
    event: input.event,
    context: input.context,
  });

  expect(result.match).toBeNull();
  expect(result.preventDefault).toBe(false);
  expect(result.nextChordState).toEqual(initialChordState());
}

interface MatchingShortcutCase {
  name: string;
  event: Partial<KeyboardShortcutInput>;
  context?: Partial<KeyboardShortcutContext>;
  action: string;
  payload?: unknown;
  preventDefault?: boolean;
  stopPropagation?: boolean;
}

interface NonMatchingShortcutCase {
  name: string;
  event: Partial<KeyboardShortcutInput>;
  context?: Partial<KeyboardShortcutContext>;
}

interface HelpSectionCase {
  name: string;
  context: {
    isMac: boolean;
    isDesktop: boolean;
  };
  expectedKeys: Record<string, string[]>;
}

describe("keyboard-shortcuts", () => {
  const matchingCases: MatchingShortcutCase[] = [
    {
      name: "matches Cmd+O to open project",
      event: { key: "o", code: "KeyO", metaKey: true },
      context: { isMac: true },
      action: "agent.new",
    },
    {
      name: "matches Cmd+N to create new workspace on mac",
      event: { key: "n", code: "KeyN", metaKey: true },
      context: { isMac: true, commandCenterOpen: false },
      action: "workspace.new",
    },
    {
      name: "matches Ctrl+N to create new workspace on non-mac",
      event: { key: "n", code: "KeyN", ctrlKey: true },
      context: { isMac: false, commandCenterOpen: false, focusScope: "other" },
      action: "workspace.new",
    },
    {
      name: "matches Cmd+P to search workspace files on mac",
      event: { key: "p", code: "KeyP", metaKey: true },
      context: { isMac: true, commandCenterOpen: false },
      action: "command-center.files",
    },
    {
      name: "matches Ctrl+P to search workspace files on non-mac",
      event: { key: "p", code: "KeyP", ctrlKey: true },
      context: { isMac: false, commandCenterOpen: false, focusScope: "other" },
      action: "command-center.files",
    },
    {
      name: "matches question-mark shortcut to toggle the shortcuts dialog",
      event: { key: "?", code: "Slash", shiftKey: true },
      context: { focusScope: "other" },
      action: "shortcuts.dialog.toggle",
    },
    {
      name: "matches workspace index jump on web via Alt+digit",
      event: { key: "2", code: "Digit2", altKey: true },
      context: { isDesktop: false },
      action: "workspace.navigate.index",
      payload: { index: 2 },
    },
    {
      name: "matches workspace index jump on desktop via Mod+digit",
      event: { key: "2", code: "Digit2", metaKey: true },
      context: { isMac: true, isDesktop: true },
      action: "workspace.navigate.index",
      payload: { index: 2 },
    },
    {
      name: "matches tab index jump on mac desktop via Cmd+Alt+digit",
      event: { key: "@", code: "Digit2", metaKey: true, altKey: true },
      context: { isMac: true, isDesktop: true },
      action: "workspace.tab.navigate.index",
      payload: { index: 2 },
    },
    {
      name: "matches tab index jump on non-mac desktop via Alt+digit",
      event: { key: "2", code: "Digit2", altKey: true },
      context: { isMac: false, isDesktop: true },
      action: "workspace.tab.navigate.index",
      payload: { index: 2 },
    },
    {
      name: "matches tab index jump on web via Alt+Shift+digit",
      event: { key: "@", code: "Digit2", altKey: true, shiftKey: true },
      context: { isDesktop: false },
      action: "workspace.tab.navigate.index",
      payload: { index: 2 },
    },
    {
      name: "matches workspace relative navigation on web via Alt+[",
      event: { key: "[", code: "BracketLeft", altKey: true },
      context: { isDesktop: false },
      action: "workspace.navigate.relative",
      payload: { delta: -1 },
    },
    {
      name: "matches workspace relative navigation on desktop via Mod+]",
      event: { key: "]", code: "BracketRight", ctrlKey: true },
      context: { isDesktop: true },
      action: "workspace.navigate.relative",
      payload: { delta: 1 },
    },
    {
      name: "matches tab relative navigation via Alt+Shift+]",
      event: { key: "}", code: "BracketRight", altKey: true, shiftKey: true },
      action: "workspace.tab.navigate.relative",
      payload: { delta: 1 },
    },
    {
      name: "matches Mod+T to open new tab",
      event: { key: "t", code: "KeyT", metaKey: true },
      context: { isMac: true },
      action: "workspace.tab.new",
    },
    {
      name: "matches Alt+Shift+W to close current tab on web",
      event: { key: "W", code: "KeyW", altKey: true, shiftKey: true },
      context: { isDesktop: false },
      action: "workspace.tab.close.current",
    },
    {
      name: "matches Cmd+W to close current tab on mac desktop",
      event: { key: "w", code: "KeyW", metaKey: true },
      context: { isMac: true, isDesktop: true },
      action: "workspace.tab.close.current",
    },
    {
      name: "matches Ctrl+W to close current tab on non-mac desktop",
      event: { key: "w", code: "KeyW", ctrlKey: true },
      context: { isMac: false, isDesktop: true },
      action: "workspace.tab.close.current",
    },
    {
      name: "matches Ctrl+O to open project on non-mac",
      event: { key: "o", code: "KeyO", ctrlKey: true },
      context: { isMac: false },
      action: "agent.new",
    },
    {
      name: "matches Ctrl+K for command center on non-mac",
      event: { key: "k", code: "KeyK", ctrlKey: true },
      context: { isMac: false },
      action: "command-center.toggle",
    },
    {
      name: "matches Cmd+Backslash to split pane right on macOS",
      event: { key: "\\", code: "Backslash", metaKey: true },
      context: { isMac: true },
      action: "workspace.pane.split.right",
    },
    {
      name: "matches Cmd+Shift+Backslash to split pane down on macOS",
      event: { key: "|", code: "Backslash", metaKey: true, shiftKey: true },
      context: { isMac: true },
      action: "workspace.pane.split.down",
    },
    {
      name: "matches Cmd+Shift+ArrowRight to focus pane right on macOS",
      event: { key: "ArrowRight", code: "ArrowRight", metaKey: true, shiftKey: true },
      context: { isMac: true },
      action: "workspace.pane.focus.right",
    },
    {
      name: "matches Cmd+Shift+Alt+ArrowDown to move tab down on macOS",
      event: {
        key: "ArrowDown",
        code: "ArrowDown",
        metaKey: true,
        shiftKey: true,
        altKey: true,
      },
      context: { isMac: true },
      action: "workspace.pane.move-tab.down",
    },
    {
      name: "matches Cmd+Shift+W to close pane on macOS",
      event: { key: "W", code: "KeyW", metaKey: true, shiftKey: true },
      context: { isMac: true },
      action: "workspace.pane.close",
    },
    {
      name: "matches Cmd+B sidebar toggle on macOS",
      event: { key: "b", code: "KeyB", metaKey: true },
      context: { isMac: true },
      action: "sidebar.toggle.left",
    },
    {
      name: "routes Mod+. to toggle both sidebars on non-mac",
      event: { key: ".", code: "Period", ctrlKey: true },
      context: { isMac: false },
      action: "sidebar.toggle.both",
    },
    {
      name: "matches Dvorak logical Cmd+. to toggle both sidebars on macOS",
      event: { key: ".", code: "KeyE", metaKey: true },
      context: { isMac: true },
      action: "sidebar.toggle.both",
    },
    {
      name: "routes Mod+D to message-input action outside terminal",
      event: { key: "d", code: "KeyD", metaKey: true },
      context: { isMac: true, focusScope: "message-input" },
      action: "message-input.action",
      payload: { kind: "dictation-toggle" },
    },
    {
      name: "routes Shift+Tab to cycle agent mode from the message input",
      event: { key: "Tab", code: "Tab", shiftKey: true },
      context: { focusScope: "message-input" },
      action: "message-input.action",
      payload: { kind: "mode-cycle" },
    },
    {
      name: "routes space to voice mute toggle outside editable scopes",
      event: { key: " ", code: "Space" },
      context: { focusScope: "other" },
      action: "message-input.action",
      payload: { kind: "voice-mute-toggle" },
    },
    {
      name: "routes Escape to agent interrupt outside terminal focus",
      event: { key: "Escape", code: "Escape" },
      context: { focusScope: "message-input" },
      action: "agent.interrupt",
      preventDefault: false,
      stopPropagation: false,
    },
    // macOS rewrites event.key when Option is held (Option+T -> "†",
    // Option+[ -> "“", Option+Shift+W -> "„", etc.). Every Alt-bound
    // letter / bracket shortcut must still resolve.
    {
      name: "matches Cmd+Alt+T to cycle theme on macOS when Option substitutes event.key",
      event: { key: "\u2020", code: "KeyT", metaKey: true, altKey: true },
      context: { isMac: true },
      action: "theme.cycle",
    },
    {
      name: "matches Alt+Shift+[ to previous tab on macOS when Option substitutes event.key",
      event: { key: "\u201D", code: "BracketLeft", altKey: true, shiftKey: true },
      context: { isMac: true },
      action: "workspace.tab.navigate.relative",
      payload: { delta: -1 },
    },
    {
      name: "matches Alt+Shift+] to next tab on macOS when Option substitutes event.key",
      event: { key: "\u2019", code: "BracketRight", altKey: true, shiftKey: true },
      context: { isMac: true },
      action: "workspace.tab.navigate.relative",
      payload: { delta: 1 },
    },
    {
      name: "matches Alt+[ to previous workspace on macOS web when Option substitutes event.key",
      event: { key: "\u201C", code: "BracketLeft", altKey: true },
      context: { isMac: true, isDesktop: false },
      action: "workspace.navigate.relative",
      payload: { delta: -1 },
      preventDefault: true,
      stopPropagation: true,
    },
    {
      name: "matches Alt+] to next workspace on macOS web when Option substitutes event.key",
      event: { key: "\u2018", code: "BracketRight", altKey: true },
      context: { isMac: true, isDesktop: false },
      action: "workspace.navigate.relative",
      payload: { delta: 1 },
      preventDefault: true,
      stopPropagation: true,
    },
    {
      name: "matches Alt+Shift+W to close current tab on macOS web when Option substitutes event.key",
      event: { key: "\u201E", code: "KeyW", altKey: true, shiftKey: true },
      context: { isMac: true, isDesktop: false },
      action: "workspace.tab.close.current",
    },
  ];

  it.each(matchingCases)(
    "$name",
    ({ event, context, action, payload, preventDefault, stopPropagation }) => {
      expectShortcutResolution({
        event,
        context,
        action,
        ...(payload !== undefined ? { payload } : {}),
        ...(preventDefault !== undefined ? { preventDefault } : {}),
        ...(stopPropagation !== undefined ? { stopPropagation } : {}),
      });
    },
  );

  it("leaves Escape to an editable field", () => {
    expectNoShortcutResolution({
      event: { key: "Escape", code: "Escape" },
      context: { focusScope: "editable" },
    });
  });

  const nonMatchingCases: NonMatchingShortcutCase[] = [
    {
      name: "does not keep old Mod+Alt+N binding",
      event: { key: "n", code: "KeyN", metaKey: true, altKey: true },
      context: { isMac: true },
    },
    {
      name: "does not keep old Alt+Shift+T binding",
      event: { key: "T", code: "KeyT", altKey: true, shiftKey: true },
    },
    {
      name: "does not keep old Cmd+Shift+O open-project binding after rebind to Cmd+O",
      event: { key: "O", code: "KeyO", metaKey: true, shiftKey: true },
      context: { isMac: true },
    },
    {
      name: "does not keep old Ctrl+Shift+O open-project binding after rebind to Ctrl+O",
      event: { key: "O", code: "KeyO", ctrlKey: true, shiftKey: true },
      context: { isMac: false },
    },
    {
      name: "does not match question-mark shortcut inside editable scopes",
      event: { key: "?", code: "Slash", shiftKey: true },
      context: { focusScope: "message-input" },
    },
    {
      name: "does not switch project with Ctrl+P on non-mac while terminal is focused",
      event: { key: "p", code: "KeyP", ctrlKey: true },
      context: { isMac: false, focusScope: "terminal" },
    },
    {
      name: "does not switch project with Cmd+P while the command center is open",
      event: { key: "p", code: "KeyP", metaKey: true },
      context: { isMac: true, commandCenterOpen: true },
    },
    {
      name: "does not close tab with Ctrl+W on mac desktop (Cmd+W only)",
      event: { key: "w", code: "KeyW", ctrlKey: true },
      context: { isMac: true, isDesktop: true },
    },
    {
      name: "does not close tab with Ctrl+W on non-mac desktop when terminal is focused",
      event: { key: "w", code: "KeyW", ctrlKey: true },
      context: { isMac: false, isDesktop: true, focusScope: "terminal" },
    },
    {
      name: "does not match Ctrl+T on mac (Cmd only)",
      event: { key: "t", code: "KeyT", ctrlKey: true },
      context: { isMac: true },
    },
    {
      name: "keeps mac Option+digit available for international text input",
      event: { key: "@", code: "Digit2", altKey: true },
      context: { isMac: true, isDesktop: true, focusScope: "message-input" },
    },
    {
      name: "does not match Ctrl+K for command center on non-mac in terminal",
      event: { key: "k", code: "KeyK", ctrlKey: true },
      context: { isMac: false, focusScope: "terminal" },
    },
    {
      name: "does not bind Ctrl+B on non-mac while terminal is focused",
      event: { key: "b", code: "KeyB", ctrlKey: true },
      context: { isMac: false, focusScope: "terminal" },
    },
    {
      name: "does not route message-input actions when terminal is focused",
      event: { key: "d", code: "KeyD", metaKey: true },
      context: { isMac: true, focusScope: "terminal" },
    },
    {
      name: "does not cycle agent mode outside the message input",
      event: { key: "Tab", code: "Tab", shiftKey: true },
      context: { focusScope: "other" },
    },
    {
      name: "does not repeat agent mode cycling while Shift+Tab is held",
      event: { key: "Tab", code: "Tab", shiftKey: true, repeat: true },
      context: { focusScope: "message-input" },
    },
    {
      name: "does not bind Cmd+Enter as a rebindable message queue shortcut",
      event: { key: "Enter", code: "Enter", metaKey: true },
      context: { isMac: true, focusScope: "message-input" },
    },
    {
      name: "does not bind Ctrl+Enter as a rebindable message queue shortcut",
      event: { key: "Enter", code: "Enter", ctrlKey: true },
      context: { isMac: false, focusScope: "message-input" },
    },
    {
      name: "does not interrupt agent when terminal is focused",
      event: { key: "Escape", code: "Escape" },
      context: { focusScope: "terminal" },
    },
    {
      name: "does not interrupt agent when command center is open",
      event: { key: "Escape", code: "Escape" },
      context: { commandCenterOpen: true },
    },
    {
      name: "does not bind pane shortcuts on non-mac platforms",
      event: { key: "\\", code: "Backslash", ctrlKey: true },
      context: { isMac: false },
    },
    {
      name: "keeps Cmd+Shift+ArrowRight available for message input selection",
      event: { key: "ArrowRight", code: "ArrowRight", metaKey: true, shiftKey: true },
      context: { isMac: true, focusScope: "message-input" },
    },
    {
      name: "keeps Cmd+Shift+ArrowLeft available for generic editable selection",
      event: { key: "ArrowLeft", code: "ArrowLeft", metaKey: true, shiftKey: true },
      context: { isMac: true, focusScope: "editable" },
    },
    {
      name: "keeps space typing available in message input",
      event: { key: " ", code: "Space" },
      context: { focusScope: "message-input" },
    },
    {
      name: "keeps Dvorak Cmd+V available for paste in message input",
      event: { key: "v", code: "Period", metaKey: true },
      context: { isMac: true, isDesktop: true, focusScope: "message-input" },
    },
    // Sanity: the macOS Option-substitution fallback must still respect
    // modifier checks — pressing Option+T alone (no Cmd) must not trigger
    // the Cmd+Alt+T theme-cycle binding.
    {
      name: "does not cycle theme on macOS when Cmd is missing (Alt+T alone)",
      event: { key: "\u2020", code: "KeyT", altKey: true },
      context: { isMac: true },
    },
  ];

  it.each(nonMatchingCases)("$name", ({ event, context }) => {
    expectNoShortcutResolution({ event, context });
  });

  it("prefers advancing chord candidates over single-combo matches on the same prefix", () => {
    const bindings = buildEffectiveBindings({
      "workspace-terminal-new-ctrl-shift-t-non-mac": "Ctrl+W S",
    });
    const chordBindingIndex = bindings.findIndex(
      (binding) => binding.id === "workspace-terminal-new-ctrl-shift-t-non-mac",
    );
    expect(chordBindingIndex).toBeGreaterThan(-1);

    const firstResult = resolveShortcut({
      event: { key: "w", code: "KeyW", ctrlKey: true },
      context: { isMac: false, isDesktop: true },
      bindings,
    });

    expect(firstResult.match).toBeNull();
    expect(firstResult.preventDefault).toBe(true);
    expect(firstResult.nextChordState.step).toBe(1);
    expect(firstResult.nextChordState.candidateIndices).toEqual([chordBindingIndex]);

    const secondResult = resolveShortcut({
      event: { key: "s", code: "KeyS" },
      context: { isMac: false, isDesktop: true },
      chordState: firstResult.nextChordState,
      bindings,
    });

    expect(secondResult.match?.action).toBe("workspace.terminal.new");
    expect(secondResult.match?.payload).toBeNull();
    expect(secondResult.match?.preventDefault).toBe(true);
    expect(secondResult.match?.stopPropagation).toBe(true);
    expect(secondResult.preventDefault).toBe(false);
    expect(secondResult.nextChordState).toEqual(initialChordState());
  });

  it("resolves a browser-origin shortcut with browser focus instead of host focus", () => {
    expectShortcutResolution({
      event: { key: "t", code: "KeyT", ctrlKey: true },
      context: { isDesktop: true, focusScope: "browser" },
      action: "workspace.tab.new",
    });
  });

  it("schedules a chord reset timeout for advancing candidates", () => {
    vi.useFakeTimers();

    const bindings = buildEffectiveBindings({
      "workspace-terminal-new-ctrl-shift-t-non-mac": "Ctrl+W S",
    });
    const onChordReset = vi.fn();

    const result = resolveShortcut({
      event: { key: "w", code: "KeyW", ctrlKey: true },
      context: { isMac: false, isDesktop: true },
      onChordReset,
      bindings,
    });

    expect(result.match).toBeNull();
    expect(result.preventDefault).toBe(true);
    expect(result.nextChordState.timeoutId).not.toBeNull();

    vi.advanceTimersByTime(1500);

    expect(onChordReset).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe("keyboard-shortcut help sections", () => {
  function findRow(sections: ReturnType<typeof buildKeyboardShortcutHelpSections>, id: string) {
    for (const section of sections) {
      const row = section.rows.find((candidate) => candidate.id === id);
      if (row) {
        return row;
      }
    }
    return null;
  }

  const helpCases: HelpSectionCase[] = [
    {
      name: "uses web defaults for workspace and tab jump",
      context: { isMac: true, isDesktop: false },
      expectedKeys: {
        "new-agent": ["mod", "O"],
        "workspace-tab-new": ["mod", "T"],
        "workspace-jump-index": ["alt", "1-9"],
        "workspace-tab-jump-index": ["alt", "shift", "1-9"],
        "workspace-tab-close-current": ["alt", "shift", "W"],
        "workspace-pane-split-right": ["mod", "\\"],
        "workspace-pane-close": ["mod", "shift", "W"],
        "cycle-agent-mode": ["shift", "Tab"],
      },
    },
    {
      name: "uses desktop defaults for workspace and tab jump",
      context: { isMac: true, isDesktop: true },
      expectedKeys: {
        "new-agent": ["mod", "O"],
        "new-workspace": ["mod", "N"],
        "workspace-tab-new": ["mod", "T"],
        "workspace-jump-index": ["mod", "1-9"],
        "workspace-tab-jump-index": ["mod", "alt", "1-9"],
        // Derived from `combo: "Cmd+W"`, so the token is `mod` where the row
        // used to be hand-authored as `meta`. This binding is mac-only and
        // `formatShortcut` renders both as ⌘, so the badge is unchanged — see
        // the render assertion below.
        "workspace-tab-close-current": ["mod", "W"],
        "workspace-pane-split-right": ["mod", "\\"],
        "workspace-pane-close": ["mod", "shift", "W"],
      },
    },
    {
      name: "uses non-mac desktop defaults for tab jump and close tab",
      context: { isMac: false, isDesktop: true },
      expectedKeys: {
        "workspace-tab-jump-index": ["alt", "1-9"],
        "workspace-tab-close-current": ["ctrl", "W"],
      },
    },
    {
      name: "uses ctrl+b for the left sidebar and ctrl+period for both sidebars on non-mac",
      context: { isMac: false, isDesktop: false },
      // Derived from `combo: "Ctrl+B"` / `"Ctrl+."`, so the token is `ctrl` where
      // these rows used to be hand-authored as `mod`. Both bindings are non-mac
      // only and `formatShortcut` labels either token "Ctrl" there, so the badge
      // is unchanged — see the render assertion below.
      expectedKeys: {
        "toggle-left-sidebar": ["ctrl", "B"],
        "toggle-both-sidebars": ["ctrl", "."],
      },
    },
  ];

  it.each(helpCases)("$name", ({ context, expectedKeys }) => {
    const sections = buildKeyboardShortcutHelpSections(context);

    for (const [id, keys] of Object.entries(expectedKeys)) {
      expect(findRow(sections, id)?.chord).toEqual([keys]);
    }
  });

  describe("rows derive their keys from the binding that fires", () => {
    const macDesktop = { isMac: true, isDesktop: true };
    const NEW_WORKSPACE_BINDING = "workspace-new-cmd-n-mac";
    const MAC_INDEX_BINDING = "workspace-navigate-index-cmd-digit-mac";
    const PANE_FOCUS_LEFT_BINDING = "workspace-pane-focus-left-cmd-shift-left";
    const SHOW_SHORTCUTS_BINDING = "shortcuts-dialog-toggle-question-mark";

    function rowChord(overrides: ShortcutOverrides, id: string) {
      const sections = buildKeyboardShortcutHelpSections(
        macDesktop,
        buildEffectiveBindings(overrides),
      );
      return findRow(sections, id)?.chord ?? null;
    }

    // The reported bug: the cheat sheet advertised the shipped default no matter
    // what the user had rebound the shortcut to.
    it("shows the override, not the shipped default", () => {
      expect(rowChord({}, "new-workspace")).toEqual([["mod", "N"]]);
      expect(rowChord({ [NEW_WORKSPACE_BINDING]: "Cmd+Shift+K" }, "new-workspace")).toEqual([
        ["mod", "shift", "K"],
      ]);
    });

    it("shows every step of a multi-step chord override", () => {
      expect(rowChord({ [NEW_WORKSPACE_BINDING]: "Cmd+K Cmd+N" }, "new-workspace")).toEqual([
        ["mod", "K"],
        ["mod", "N"],
      ]);
    });

    it("reports an unassigned row as having no keys at all", () => {
      expect(rowChord({ [NEW_WORKSPACE_BINDING]: UNASSIGNED_COMBO }, "new-workspace")).toBeNull();
    });

    it("returns to the shipped default once the override is cleared", () => {
      expect(rowChord({ [NEW_WORKSPACE_BINDING]: "Cmd+Shift+K" }, "new-workspace")).toEqual([
        ["mod", "shift", "K"],
      ]);
      expect(rowChord({}, "new-workspace")).toEqual([["mod", "N"]]);
    });

    // An arrow override used to render as the raw `ARROWLEFT` code, because the
    // display path uppercased key names past the table that maps them to arrows.
    it("renders an arrow override as an arrow", () => {
      const chord = rowChord(
        { [PANE_FOCUS_LEFT_BINDING]: "Cmd+Alt+ArrowLeft" },
        "workspace-pane-focus-left",
      );
      expect(chord).toEqual([["mod", "alt", "Left"]]);
      expect(formatShortcut(chord?.[0] ?? [], "mac")).toBe("⌥⌘←");
    });

    // `1-9` and `?` are display-only tokens no combo string can spell, so these
    // two rows opt out of default derivation via `help.defaultDisplayKeys`.
    it("keeps the wildcard token on the index-jump row", () => {
      expect(rowChord({}, "workspace-jump-index")).toEqual([["mod", "1-9"]]);
    });

    it("keeps the bare ? on the show-shortcuts row rather than deriving Shift+?", () => {
      expect(rowChord({}, "show-shortcuts")).toEqual([["?"]]);
    });

    it("replaces the default-only wildcard when the index jump is rebound", () => {
      expect(rowChord({ [MAC_INDEX_BINDING]: "Ctrl+Digit" }, "workspace-jump-index")).toEqual([
        ["ctrl", "Digit"],
      ]);
    });

    it("replaces the default-only ? when show shortcuts is rebound", () => {
      expect(rowChord({ [SHOW_SHORTCUTS_BINDING]: "Cmd+K" }, "show-shortcuts")).toEqual([
        ["mod", "K"],
      ]);
    });

    // The authored row said `meta`, the derived row says `mod`. Both render ⌘ on
    // mac and this binding is mac-only, so nothing the user sees moved.
    it("still renders close-tab as ⌘W after switching to the derived token", () => {
      const sections = buildKeyboardShortcutHelpSections(macDesktop);
      const chord = findRow(sections, "workspace-tab-close-current")?.chord;
      expect(formatShortcut(chord?.[0] ?? [], "mac")).toBe("⌘W");
    });

    // Same story on the other side: these rows said `mod`, the non-mac combos
    // say `Ctrl`, and non-mac labels both as "Ctrl".
    it("still renders the sidebar toggles as Ctrl+B and Ctrl+. on non-mac", () => {
      const sections = buildKeyboardShortcutHelpSections({ isMac: false, isDesktop: false });
      const left = findRow(sections, "toggle-left-sidebar")?.chord;
      const both = findRow(sections, "toggle-both-sidebars")?.chord;
      expect(formatShortcut(left?.[0] ?? [], "non-mac")).toBe("Ctrl+B");
      expect(formatShortcut(both?.[0] ?? [], "non-mac")).toBe("Ctrl+.");
    });
  });

  it("returns stable i18n keys for section titles and help rows", () => {
    const sections = buildKeyboardShortcutHelpSections({ isMac: true, isDesktop: true });
    const workspaces = sections.find((section) => section.id === "workspaces");
    const layout = sections.find((section) => section.id === "layout");
    const openProject = findRow(sections, "new-agent");
    const cycleAgentMode = findRow(sections, "cycle-agent-mode");
    const showShortcuts = findRow(sections, "show-shortcuts");

    expect(workspaces?.titleKey).toBe("settings.shortcuts.sections.workspaces");
    expect(layout?.titleKey).toBe("settings.shortcuts.sections.layout");
    expect(openProject?.labelKey).toBe("settings.shortcuts.help.openProject");
    expect(openProject?.label).toBe("Open project");
    expect(cycleAgentMode?.labelKey).toBe("settings.shortcuts.help.cycleAgentMode");
    expect(showShortcuts?.noteKey).toBe("settings.shortcuts.helpNotes.showKeyboardShortcuts");
  });

  it("gives every help row an explicit place in its section's order", () => {
    const platforms = [
      { isMac: true, isDesktop: true },
      { isMac: false, isDesktop: true },
      { isMac: true, isDesktop: false },
      { isMac: false, isDesktop: false },
    ];
    const unplaced: string[] = [];
    for (const platform of platforms) {
      for (const section of buildKeyboardShortcutHelpSections(platform)) {
        for (const row of section.rows) {
          if (SHORTCUT_HELP_ROW_ORDER[section.id].includes(row.id)) continue;
          unplaced.push(`${section.id}:${row.id}`);
        }
      }
    }

    expect(unplaced).toEqual([]);
  });

  it("leads the general section with the command center and file search", () => {
    const sections = buildKeyboardShortcutHelpSections({ isMac: true, isDesktop: true });

    expect(sections[0]?.id).toBe("general");
    expect(sections[0]?.rows.slice(0, 2).map((row) => row.id)).toEqual([
      "toggle-command-center",
      "search-files",
    ]);
  });

  it("reuses the project-picker binding ids for rebindable file search", () => {
    expect(getBindingIdForAction("search-files", { isMac: true, isDesktop: true })).toBe(
      "workspace-project-pick-cmd-p-mac",
    );
    expect(getBindingIdForAction("search-files", { isMac: false, isDesktop: true })).toBe(
      "workspace-project-pick-ctrl-p-non-mac",
    );
    expect(
      findRow(buildKeyboardShortcutHelpSections({ isMac: true, isDesktop: true }), "search-files")
        ?.chord,
    ).not.toBeNull();
  });

  it("does not expose Enter send behavior as rebindable shortcut rows", () => {
    const sections = buildKeyboardShortcutHelpSections({ isMac: true, isDesktop: true });

    expect(findRow(sections, "message-input-send")).toBeNull();
    expect(findRow(sections, "message-input-queue")).toBeNull();
    expect(
      getBindingIdForAction("message-input-send", { isMac: true, isDesktop: true }),
    ).toBeNull();
    expect(
      getBindingIdForAction("message-input-queue", { isMac: true, isDesktop: true }),
    ).toBeNull();
  });
});

describe("getWorkspaceIndexJumpModifierKey", () => {
  const MAC_INDEX_BINDING = "workspace-navigate-index-cmd-digit-mac";

  it("uses Alt on web, regardless of OS", () => {
    expect(getWorkspaceIndexJumpModifierKey({ isMac: true, isDesktop: false })).toBe("Alt");
    expect(getWorkspaceIndexJumpModifierKey({ isMac: false, isDesktop: false })).toBe("Alt");
  });

  it("uses Cmd (Meta) on desktop Mac, not Control or Alt", () => {
    expect(getWorkspaceIndexJumpModifierKey({ isMac: true, isDesktop: true })).toBe("Meta");
  });

  it("uses Ctrl on desktop non-Mac, not Meta or Alt", () => {
    expect(getWorkspaceIndexJumpModifierKey({ isMac: false, isDesktop: true })).toBe("Control");
  });

  it("derives the modifier from the effective binding, not the platform", () => {
    const bindings = buildEffectiveBindings({ [MAC_INDEX_BINDING]: "Alt+Digit" });
    expect(getWorkspaceIndexJumpModifierKey({ isMac: true, isDesktop: true }, bindings)).toBe(
      "Alt",
    );
  });

  it("suppresses the badges when the jump shortcut is unassigned", () => {
    const bindings = buildEffectiveBindings({ [MAC_INDEX_BINDING]: UNASSIGNED_COMBO });
    expect(getWorkspaceIndexJumpModifierKey({ isMac: true, isDesktop: true }, bindings)).toBeNull();
  });

  it("suppresses the badges when the jump shortcut is rebound to one concrete digit", () => {
    // Capture can only ever produce a concrete digit, never the 1-9 wildcard,
    // so the badges would advertise eight workspaces that no longer respond.
    const bindings = buildEffectiveBindings({ [MAC_INDEX_BINDING]: "Cmd+3" });
    expect(getWorkspaceIndexJumpModifierKey({ isMac: true, isDesktop: true }, bindings)).toBeNull();
  });

  it("suppresses the badges for a multi-step chord", () => {
    const bindings = buildEffectiveBindings({ [MAC_INDEX_BINDING]: "Cmd+K Cmd+Digit" });
    expect(getWorkspaceIndexJumpModifierKey({ isMac: true, isDesktop: true }, bindings)).toBeNull();
  });

  it("suppresses the badges when the combo needs a second modifier", () => {
    const bindings = buildEffectiveBindings({ [MAC_INDEX_BINDING]: "Cmd+Shift+Digit" });
    expect(getWorkspaceIndexJumpModifierKey({ isMac: true, isDesktop: true }, bindings)).toBeNull();
  });
});

function parseUnknownBindingChord() {
  return parseBindingChord("Ctrl+Nonsense");
}

/**
 * Effective bindings with one help row rewritten to ship without a default
 * combo, standing in for a binding authored as `combo: ""`. `help.keys` is left
 * as authored so the empty parsed chord is the only signal.
 */
function withoutDefaultCombo(helpId: string): ParsedShortcutBinding[] {
  const bindings: ParsedShortcutBinding[] = [];
  for (const binding of buildEffectiveBindings({})) {
    if (binding.help?.id === helpId) {
      bindings.push(Object.assign({}, binding, { combo: "", parsedChord: [] }));
    } else {
      bindings.push(binding);
    }
  }
  return bindings;
}

describe("unassigned shortcuts", () => {
  const TAB_NEW_BINDING = "workspace-tab-new-ctrl-t-non-mac";
  const desktopNonMac = { isMac: false, isDesktop: true };

  function findRow(sections: ReturnType<typeof buildKeyboardShortcutHelpSections>, id: string) {
    for (const section of sections) {
      const row = section.rows.find((candidate) => candidate.id === id);
      if (row) {
        return row;
      }
    }
    return null;
  }

  describe("parseBindingChord", () => {
    it("yields an empty chord for a binding that ships without a default combo", () => {
      expect(parseBindingChord("")).toEqual([]);
    });

    it("parses a normal combo into one step", () => {
      expect(parseBindingChord("Ctrl+T")).toHaveLength(1);
    });

    it("parses a chord into one step per combo", () => {
      expect(parseBindingChord("Ctrl+W S")).toHaveLength(2);
    });

    it("still throws on an unparseable combo", () => {
      expect(parseUnknownBindingChord).toThrow();
    });
  });

  describe("matching", () => {
    it("stops matching a shortcut the user unassigned", () => {
      const bindings = buildEffectiveBindings({ [TAB_NEW_BINDING]: UNASSIGNED_COMBO });

      const result = resolveShortcut({
        event: { key: "t", code: "KeyT", ctrlKey: true },
        context: desktopNonMac,
        bindings,
      });

      expect(result.match).toBeNull();
    });

    it("leaves other shortcuts firing when one is unassigned", () => {
      const bindings = buildEffectiveBindings({ [TAB_NEW_BINDING]: UNASSIGNED_COMBO });

      const result = resolveShortcut({
        event: { key: "t", code: "KeyT", ctrlKey: true, shiftKey: true },
        context: desktopNonMac,
        bindings,
      });

      expect(result.match?.action).toBe("workspace.terminal.new");
    });

    it("restores the default when the override is removed", () => {
      const bindings = buildEffectiveBindings({});

      const result = resolveShortcut({
        event: { key: "t", code: "KeyT", ctrlKey: true },
        context: desktopNonMac,
        bindings,
      });

      expect(result.match?.action).toBe("workspace.tab.new");
    });

    it("treats a stored empty combo as unassigned too", () => {
      const bindings = buildEffectiveBindings({ [TAB_NEW_BINDING]: "" });

      const result = resolveShortcut({
        event: { key: "t", code: "KeyT", ctrlKey: true },
        context: desktopNonMac,
        bindings,
      });

      expect(result.match).toBeNull();
    });

    it("keeps rebinding to a real combo working", () => {
      const bindings = buildEffectiveBindings({ [TAB_NEW_BINDING]: "Ctrl+Y" });

      expect(
        resolveShortcut({
          event: { key: "y", code: "KeyY", ctrlKey: true },
          context: desktopNonMac,
          bindings,
        }).match?.action,
      ).toBe("workspace.tab.new");
      expect(
        resolveShortcut({
          event: { key: "t", code: "KeyT", ctrlKey: true },
          context: desktopNonMac,
          bindings,
        }).match,
      ).toBeNull();
    });

    it("falls back to the default for a non-string stored value", () => {
      // Storage is unvalidated JSON, so a corrupt value must not throw.
      const overrides = { [TAB_NEW_BINDING]: 42 } as unknown as ShortcutOverrides;
      const bindings = buildEffectiveBindings(overrides);

      const result = resolveShortcut({
        event: { key: "t", code: "KeyT", ctrlKey: true },
        context: desktopNonMac,
        bindings,
      });

      expect(result.match?.action).toBe("workspace.tab.new");
    });
  });

  describe("resolveShortcutKeysForAction", () => {
    // `ctrl`, not `mod`: these keys are derived from the non-mac binding's
    // `combo: "Ctrl+T"` rather than hand-authored. `formatShortcut` labels both
    // tokens "Ctrl" off mac, and this binding is non-mac only.
    it("returns the default keys when there is no override", () => {
      expect(resolveShortcutKeysForAction("workspace-tab-new", {}, desktopNonMac)).toEqual([
        ["ctrl", "T"],
      ]);
    });

    it("returns null when the user unassigned the shortcut", () => {
      expect(
        resolveShortcutKeysForAction(
          "workspace-tab-new",
          { [TAB_NEW_BINDING]: UNASSIGNED_COMBO },
          desktopNonMac,
        ),
      ).toBeNull();
    });

    it("returns the override keys when the shortcut is rebound", () => {
      expect(
        resolveShortcutKeysForAction(
          "workspace-tab-new",
          { [TAB_NEW_BINDING]: "Ctrl+Y" },
          desktopNonMac,
        ),
      ).toEqual([["ctrl", "Y"]]);
    });

    it("falls back to the default keys for an unparseable override", () => {
      // Matching falls back to the default here, so the display has to as well
      // or it would advertise keys that do nothing.
      expect(
        resolveShortcutKeysForAction(
          "workspace-tab-new",
          { [TAB_NEW_BINDING]: "Ctrl+Nonsense" },
          desktopNonMac,
        ),
      ).toEqual([["ctrl", "T"]]);
    });

    it("falls back to the default keys for a non-string stored value", () => {
      const overrides = { [TAB_NEW_BINDING]: 42 } as unknown as ShortcutOverrides;
      expect(resolveShortcutKeysForAction("workspace-tab-new", overrides, desktopNonMac)).toEqual([
        ["ctrl", "T"],
      ]);
    });

    it("returns null for an action with no binding on this platform", () => {
      expect(resolveShortcutKeysForAction("message-input-send", {}, desktopNonMac)).toBeNull();
    });
  });

  describe("help rows", () => {
    it("lists no keys for an unassigned shortcut", () => {
      const bindings = buildEffectiveBindings({ [TAB_NEW_BINDING]: UNASSIGNED_COMBO });
      const sections = buildKeyboardShortcutHelpSections(desktopNonMac, bindings);

      expect(findRow(sections, "workspace-tab-new")?.chord).toBeNull();
    });

    it("keeps the row so the shortcut stays rebindable", () => {
      const bindings = buildEffectiveBindings({ [TAB_NEW_BINDING]: UNASSIGNED_COMBO });
      const sections = buildKeyboardShortcutHelpSections(desktopNonMac, bindings);

      expect(findRow(sections, "workspace-tab-new")).not.toBeNull();
      expect(getBindingIdForAction("workspace-tab-new", desktopNonMac)).toBe(TAB_NEW_BINDING);
    });

    it("still lists the default keys when nothing is overridden", () => {
      const sections = buildKeyboardShortcutHelpSections(desktopNonMac);

      expect(findRow(sections, "workspace-tab-new")?.chord).toEqual([["ctrl", "T"]]);
      expect(getDefaultKeysForAction("workspace-tab-new", desktopNonMac)).toEqual([["ctrl", "T"]]);
    });

    // A binding authored with `combo: ""` has no default. The settings row uses
    // this to hide Reset, which would otherwise be a dead button landing on the
    // same "Not set" state Clear already produced. The empty parsed chord is what
    // marks the binding default-less.
    it("reports no default keys for a binding that ships without a combo", () => {
      const bindings = withoutDefaultCombo("workspace-tab-new");

      expect(getDefaultKeysForAction("workspace-tab-new", desktopNonMac, bindings)).toBeNull();
    });

    it("lists no help keys for a binding that ships without a combo", () => {
      const bindings = withoutDefaultCombo("workspace-tab-new");
      const sections = buildKeyboardShortcutHelpSections(desktopNonMac, bindings);

      expect(findRow(sections, "workspace-tab-new")?.chord).toBeNull();
    });
  });
});

describe("cycle sidebar grouping shortcut", () => {
  const platforms = [
    {
      context: { isMac: true, isDesktop: true },
      bindingId: "sidebar-group-mode-cycle-cmd-shift-g-mac",
    },
    {
      context: { isMac: false, isDesktop: false },
      bindingId: "sidebar-group-mode-cycle-ctrl-shift-g-non-mac",
    },
  ];

  function findHelpRow(context: { isMac: boolean; isDesktop: boolean }, id: string) {
    for (const section of buildKeyboardShortcutHelpSections(context)) {
      const row = section.rows.find((candidate) => candidate.id === id);
      if (row) return { row, sectionId: section.id };
    }
    return null;
  }

  it("fires on Cmd+Shift+G on Mac", () => {
    expectShortcutResolution({
      event: { key: "G", code: "KeyG", metaKey: true, shiftKey: true },
      context: { isMac: true },
      action: "sidebar.cycle.group-mode",
    });
  });

  it("fires on Ctrl+Shift+G off Mac", () => {
    expectShortcutResolution({
      event: { key: "G", code: "KeyG", ctrlKey: true, shiftKey: true },
      context: { isMac: false },
      action: "sidebar.cycle.group-mode",
    });
  });

  it("does not fire on the other platform's modifier", () => {
    expectNoShortcutResolution({
      event: { key: "G", code: "KeyG", ctrlKey: true, shiftKey: true },
      context: { isMac: true },
    });
  });

  it.each([
    { isMac: true, focusScope: "terminal" },
    { isMac: true, commandCenterOpen: true },
  ] satisfies Partial<KeyboardShortcutContext>[])(
    "stays out of the terminal and the command center (%j)",
    (context) => {
      expectNoShortcutResolution({
        event: { key: "G", code: "KeyG", metaKey: true, shiftKey: true },
        context,
      });
    },
  );

  it.each(platforms)("shows one Panels help row on $context.isMac", ({ context, bindingId }) => {
    const found = findHelpRow(context, "cycle-group-mode");
    expect(found?.sectionId).toBe("panels");
    expect(found?.row.keys).toEqual(["mod", "shift", "G"]);
    expect(found?.row.labelKey).toBe("settings.shortcuts.help.cycleGroupMode");
    expect(getBindingIdForAction("cycle-group-mode", context)).toBe(bindingId);
    expect(getDefaultKeysForAction("cycle-group-mode", context)).toEqual(["mod", "shift", "G"]);
  });

  it("stays rebindable to a user-chosen combo", () => {
    const bindings = buildEffectiveBindings({
      "sidebar-group-mode-cycle-cmd-shift-g-mac": "Cmd+J",
    });
    const result = resolveShortcut({
      event: { key: "j", code: "KeyJ", metaKey: true },
      context: { isMac: true },
      bindings,
    });
    expect(result.match?.action).toBe("sidebar.cycle.group-mode");
  });
});

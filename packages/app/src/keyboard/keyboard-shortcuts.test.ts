import { describe, expect, it, vi } from "vitest";
import {
  buildKeyboardShortcutHelpSections,
  buildEffectiveBindings,
  resolveKeyboardShortcut,
  type ChordState,
  type KeyboardShortcutContext,
  type ParsedShortcutBinding,
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
  event: Partial<KeyboardEvent>;
  context?: Partial<KeyboardShortcutContext>;
  chordState?: ChordState;
  onChordReset?: () => void;
  bindings?: readonly ParsedShortcutBinding[];
}) {
  return resolveKeyboardShortcut({
    event: keyboardEvent(input.event),
    context: shortcutContext(input.context),
    chordState: input.chordState ?? initialChordState(),
    onChordReset: input.onChordReset ?? (() => undefined),
    ...(input.bindings ? { bindings: input.bindings } : {}),
  });
}

function expectShortcutResolution(input: {
  event: Partial<KeyboardEvent>;
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
  event: Partial<KeyboardEvent>;
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
  event: Partial<KeyboardEvent>;
  context?: Partial<KeyboardShortcutContext>;
  action: string;
  payload?: unknown;
  preventDefault?: boolean;
  stopPropagation?: boolean;
}

interface NonMatchingShortcutCase {
  name: string;
  event: Partial<KeyboardEvent>;
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
      name: "matches Mod+Shift+O to create new agent",
      event: { key: "O", code: "KeyO", metaKey: true, shiftKey: true },
      context: { isMac: true },
      action: "agent.new",
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
      name: "matches tab index jump on desktop via Alt+digit",
      event: { key: "2", code: "Digit2", altKey: true },
      context: { isDesktop: true },
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
      name: "matches Ctrl+Shift+O to create new agent on non-mac",
      event: { key: "O", code: "KeyO", ctrlKey: true, shiftKey: true },
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
      name: "routes Mod+D to message-input action outside terminal",
      event: { key: "d", code: "KeyD", metaKey: true },
      context: { isMac: true, focusScope: "message-input" },
      action: "message-input.action",
      payload: { kind: "dictation-toggle" },
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
      name: "does not match question-mark shortcut inside editable scopes",
      event: { key: "?", code: "Slash", shiftKey: true },
      context: { focusScope: "message-input" },
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
        "new-agent": ["mod", "shift", "O"],
        "workspace-tab-new": ["mod", "T"],
        "workspace-jump-index": ["alt", "1-9"],
        "workspace-tab-jump-index": ["alt", "shift", "1-9"],
        "workspace-tab-close-current": ["alt", "shift", "W"],
        "workspace-pane-split-right": ["mod", "\\"],
        "workspace-pane-close": ["mod", "shift", "W"],
      },
    },
    {
      name: "uses desktop defaults for workspace and tab jump",
      context: { isMac: true, isDesktop: true },
      expectedKeys: {
        "new-agent": ["mod", "shift", "O"],
        "workspace-tab-new": ["mod", "T"],
        "workspace-jump-index": ["mod", "1-9"],
        "workspace-tab-jump-index": ["alt", "1-9"],
        "workspace-tab-close-current": ["meta", "W"],
        "workspace-pane-split-right": ["mod", "\\"],
        "workspace-pane-close": ["mod", "shift", "W"],
      },
    },
    {
      name: "shows Ctrl+W close tab for non-mac desktop",
      context: { isMac: false, isDesktop: true },
      expectedKeys: {
        "workspace-tab-close-current": ["ctrl", "W"],
      },
    },
    {
      name: "uses mod+b for the left sidebar and mod+period for both sidebars on non-mac",
      context: { isMac: false, isDesktop: false },
      expectedKeys: {
        "toggle-left-sidebar": ["mod", "B"],
        "toggle-both-sidebars": ["mod", "."],
      },
    },
  ];

  it.each(helpCases)("$name", ({ context, expectedKeys }) => {
    const sections = buildKeyboardShortcutHelpSections(context);

    for (const [id, keys] of Object.entries(expectedKeys)) {
      expect(findRow(sections, id)?.keys).toEqual(keys);
    }
  });
});

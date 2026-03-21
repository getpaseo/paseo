import type { ShortcutKey } from "@/utils/format-shortcut";
import type {
  KeyboardActionId,
  KeyboardFocusScope,
  KeyboardShortcutPayload,
  MessageInputKeyboardActionKind,
} from "@/keyboard/actions";
import { type KeyCombo, parseShortcutString } from "@/keyboard/shortcut-string";

export type { KeyCombo } from "@/keyboard/shortcut-string";

// --- Public types ---

export type KeyboardShortcutContext = {
  isMac: boolean;
  isDesktop: boolean;
  focusScope: KeyboardFocusScope;
  commandCenterOpen: boolean;
  hasSelectedAgent: boolean;
};

export type KeyboardShortcutMatch = {
  action: KeyboardActionId;
  payload: KeyboardShortcutPayload;
  preventDefault: boolean;
  stopPropagation: boolean;
};

export type KeyboardShortcutHelpRow = {
  id: string;
  label: string;
  keys: ShortcutKey[];
  note?: string;
};

export type KeyboardShortcutHelpSection = {
  id: "global" | "agent-input";
  title: string;
  rows: KeyboardShortcutHelpRow[];
};

// --- Binding definition types ---

type KeyboardShortcutPlatformContext = {
  isMac: boolean;
  isDesktop: boolean;
};


interface ShortcutWhen {
  /** true = mac only, false = non-mac only */
  mac?: boolean;
  /** true = desktop only, false = web only */
  desktop?: boolean;
  /** false = disabled when terminal is focused */
  terminal?: false;
  /** false = disabled when command center is open */
  commandCenter?: false;
  /** true = requires a selected agent */
  hasSelectedAgent?: true;
  /** Exact focus scope match */
  focusScope?: KeyboardFocusScope;
}

type ShortcutPayloadDef =
  | { type: "index" }
  | { type: "delta"; delta: 1 | -1 }
  | { type: "message-input"; kind: MessageInputKeyboardActionKind };

interface ShortcutHelp {
  id: string;
  section: "global" | "agent-input";
  label: string;
  keys: ShortcutKey[];
  note?: string;
}

interface ShortcutBinding {
  id: string;
  action: KeyboardActionId;
  combo: string;
  repeat?: false;
  when?: ShortcutWhen;
  payload?: ShortcutPayloadDef;
  preventDefault?: boolean;
  stopPropagation?: boolean;
  help?: ShortcutHelp;
}

export interface ParsedShortcutBinding extends ShortcutBinding {
  parsedCombo: KeyCombo;
}

// --- Constants ---

const SHORTCUT_HELP_SECTION_TITLES: Record<KeyboardShortcutHelpSection["id"], string> = {
  global: "Global",
  "agent-input": "Agent Input",
};

// --- Binding definitions ---

const SHORTCUT_BINDINGS: readonly ShortcutBinding[] = [
  // --- New agent ---
  {
    id: "agent-new-cmd-shift-o-mac",
    action: "agent.new",
    combo: "Cmd+Shift+O",
    when: { mac: true },
    help: {
      id: "new-agent",
      section: "global",
      label: "Open project",
      keys: ["mod", "shift", "O"],
    },
  },
  {
    id: "agent-new-ctrl-shift-o-non-mac",
    action: "agent.new",
    combo: "Ctrl+Shift+O",
    when: { mac: false, terminal: false },
    help: {
      id: "new-agent",
      section: "global",
      label: "Open project",
      keys: ["mod", "shift", "O"],
    },
  },

  // --- Tab management ---
  {
    id: "workspace-tab-new-cmd-t-mac",
    action: "workspace.tab.new",
    combo: "Cmd+T",
    when: { mac: true, commandCenter: false },
    help: {
      id: "workspace-tab-new",
      section: "global",
      label: "New agent tab",
      keys: ["mod", "T"],
    },
  },
  {
    id: "workspace-tab-new-ctrl-t-non-mac",
    action: "workspace.tab.new",
    combo: "Ctrl+T",
    when: { mac: false, commandCenter: false, terminal: false },
    help: {
      id: "workspace-tab-new",
      section: "global",
      label: "New agent tab",
      keys: ["mod", "T"],
    },
  },
  {
    id: "workspace-tab-close-current-cmd-w-mac",
    action: "workspace.tab.close.current",
    combo: "Cmd+W",
    when: { mac: true, desktop: true, commandCenter: false },
    help: {
      id: "workspace-tab-close-current",
      section: "global",
      label: "Close current tab",
      keys: ["meta", "W"],
    },
  },
  {
    id: "workspace-tab-close-current-ctrl-w-non-mac",
    action: "workspace.tab.close.current",
    combo: "Ctrl+W",
    when: { mac: false, desktop: true, commandCenter: false, terminal: false },
    help: {
      id: "workspace-tab-close-current",
      section: "global",
      label: "Close current tab",
      keys: ["ctrl", "W"],
    },
  },
  {
    id: "workspace-tab-close-current-alt-shift-w-web",
    action: "workspace.tab.close.current",
    combo: "Alt+Shift+W",
    when: { desktop: false, commandCenter: false },
    help: {
      id: "workspace-tab-close-current",
      section: "global",
      label: "Close current tab",
      keys: ["alt", "shift", "W"],
    },
  },

  // --- Workspace index jump ---
  {
    id: "workspace-navigate-index-cmd-digit-mac",
    action: "workspace.navigate.index",
    combo: "Cmd+Digit",
    when: { mac: true, desktop: true, commandCenter: false },
    payload: { type: "index" },
    help: {
      id: "workspace-jump-index",
      section: "global",
      label: "Jump to workspace",
      keys: ["mod", "1-9"],
    },
  },
  {
    id: "workspace-navigate-index-ctrl-digit-non-mac",
    action: "workspace.navigate.index",
    combo: "Ctrl+Digit",
    when: { mac: false, desktop: true, commandCenter: false, terminal: false },
    payload: { type: "index" },
    help: {
      id: "workspace-jump-index",
      section: "global",
      label: "Jump to workspace",
      keys: ["mod", "1-9"],
    },
  },
  {
    id: "workspace-navigate-index-alt-digit-web",
    action: "workspace.navigate.index",
    combo: "Alt+Digit",
    when: { desktop: false, commandCenter: false },
    payload: { type: "index" },
    help: {
      id: "workspace-jump-index",
      section: "global",
      label: "Jump to workspace",
      keys: ["alt", "1-9"],
    },
  },

  // --- Tab index jump ---
  {
    id: "workspace-tab-navigate-index-alt-digit-desktop",
    action: "workspace.tab.navigate.index",
    combo: "Alt+Digit",
    when: { desktop: true, commandCenter: false },
    payload: { type: "index" },
    help: {
      id: "workspace-tab-jump-index",
      section: "global",
      label: "Jump to tab",
      keys: ["alt", "1-9"],
    },
  },
  {
    id: "workspace-tab-navigate-index-alt-shift-digit-web",
    action: "workspace.tab.navigate.index",
    combo: "Alt+Shift+Digit",
    when: { desktop: false, commandCenter: false },
    payload: { type: "index" },
    help: {
      id: "workspace-tab-jump-index",
      section: "global",
      label: "Jump to tab",
      keys: ["alt", "shift", "1-9"],
    },
  },

  // --- Workspace relative navigation ---
  {
    id: "workspace-navigate-relative-cmd-left-mac",
    action: "workspace.navigate.relative",
    combo: "Cmd+[",
    when: { mac: true, desktop: true, commandCenter: false },
    payload: { type: "delta", delta: -1 },
    help: {
      id: "workspace-prev",
      section: "global",
      label: "Previous workspace",
      keys: ["mod", "["],
    },
  },
  {
    id: "workspace-navigate-relative-ctrl-left-non-mac",
    action: "workspace.navigate.relative",
    combo: "Ctrl+[",
    when: { mac: false, desktop: true, commandCenter: false, terminal: false },
    payload: { type: "delta", delta: -1 },
    help: {
      id: "workspace-prev",
      section: "global",
      label: "Previous workspace",
      keys: ["mod", "["],
    },
  },
  {
    id: "workspace-navigate-relative-cmd-right-mac",
    action: "workspace.navigate.relative",
    combo: "Cmd+]",
    when: { mac: true, desktop: true, commandCenter: false },
    payload: { type: "delta", delta: 1 },
    help: {
      id: "workspace-next",
      section: "global",
      label: "Next workspace",
      keys: ["mod", "]"],
    },
  },
  {
    id: "workspace-navigate-relative-ctrl-right-non-mac",
    action: "workspace.navigate.relative",
    combo: "Ctrl+]",
    when: { mac: false, desktop: true, commandCenter: false, terminal: false },
    payload: { type: "delta", delta: 1 },
    help: {
      id: "workspace-next",
      section: "global",
      label: "Next workspace",
      keys: ["mod", "]"],
    },
  },
  {
    id: "workspace-navigate-relative-alt-left-web",
    action: "workspace.navigate.relative",
    combo: "Alt+[",
    when: { desktop: false, commandCenter: false },
    payload: { type: "delta", delta: -1 },
    help: {
      id: "workspace-prev",
      section: "global",
      label: "Previous workspace",
      keys: ["alt", "["],
    },
  },
  {
    id: "workspace-navigate-relative-alt-right-web",
    action: "workspace.navigate.relative",
    combo: "Alt+]",
    when: { desktop: false, commandCenter: false },
    payload: { type: "delta", delta: 1 },
    help: {
      id: "workspace-next",
      section: "global",
      label: "Next workspace",
      keys: ["alt", "]"],
    },
  },

  // --- Tab relative navigation ---
  {
    id: "workspace-tab-navigate-relative-alt-shift-left",
    action: "workspace.tab.navigate.relative",
    combo: "Alt+Shift+[",
    when: { commandCenter: false },
    payload: { type: "delta", delta: -1 },
    help: {
      id: "workspace-tab-prev",
      section: "global",
      label: "Previous tab",
      keys: ["alt", "shift", "["],
    },
  },
  {
    id: "workspace-tab-navigate-relative-alt-shift-right",
    action: "workspace.tab.navigate.relative",
    combo: "Alt+Shift+]",
    when: { commandCenter: false },
    payload: { type: "delta", delta: 1 },
    help: {
      id: "workspace-tab-next",
      section: "global",
      label: "Next tab",
      keys: ["alt", "shift", "]"],
    },
  },

  // --- Pane management (mac only) ---
  {
    id: "workspace-pane-split-right-cmd-backslash",
    action: "workspace.pane.split.right",
    combo: "Cmd+\\",
    when: { mac: true, terminal: false, commandCenter: false },
    help: {
      id: "workspace-pane-split-right",
      section: "global",
      label: "Split pane right",
      keys: ["mod", "\\"],
    },
  },
  {
    id: "workspace-pane-split-down-cmd-shift-backslash",
    action: "workspace.pane.split.down",
    combo: "Cmd+Shift+\\",
    when: { mac: true, terminal: false, commandCenter: false },
    help: {
      id: "workspace-pane-split-down",
      section: "global",
      label: "Split pane down",
      keys: ["mod", "shift", "\\"],
    },
  },
  {
    id: "workspace-pane-focus-left-cmd-shift-left",
    action: "workspace.pane.focus.left",
    combo: "Cmd+Shift+ArrowLeft",
    when: { mac: true, terminal: false, commandCenter: false },
    help: {
      id: "workspace-pane-focus-left",
      section: "global",
      label: "Focus pane left",
      keys: ["mod", "shift", "Left"],
    },
  },
  {
    id: "workspace-pane-focus-right-cmd-shift-right",
    action: "workspace.pane.focus.right",
    combo: "Cmd+Shift+ArrowRight",
    when: { mac: true, terminal: false, commandCenter: false },
    help: {
      id: "workspace-pane-focus-right",
      section: "global",
      label: "Focus pane right",
      keys: ["mod", "shift", "Right"],
    },
  },
  {
    id: "workspace-pane-focus-up-cmd-shift-up",
    action: "workspace.pane.focus.up",
    combo: "Cmd+Shift+ArrowUp",
    when: { mac: true, terminal: false, commandCenter: false },
    help: {
      id: "workspace-pane-focus-up",
      section: "global",
      label: "Focus pane up",
      keys: ["mod", "shift", "Up"],
    },
  },
  {
    id: "workspace-pane-focus-down-cmd-shift-down",
    action: "workspace.pane.focus.down",
    combo: "Cmd+Shift+ArrowDown",
    when: { mac: true, terminal: false, commandCenter: false },
    help: {
      id: "workspace-pane-focus-down",
      section: "global",
      label: "Focus pane down",
      keys: ["mod", "shift", "Down"],
    },
  },
  {
    id: "workspace-pane-move-tab-left-cmd-shift-alt-left",
    action: "workspace.pane.move-tab.left",
    combo: "Cmd+Alt+Shift+ArrowLeft",
    when: { mac: true, terminal: false, commandCenter: false },
    help: {
      id: "workspace-pane-move-tab-left",
      section: "global",
      label: "Move tab left",
      keys: ["mod", "shift", "alt", "Left"],
    },
  },
  {
    id: "workspace-pane-move-tab-right-cmd-shift-alt-right",
    action: "workspace.pane.move-tab.right",
    combo: "Cmd+Alt+Shift+ArrowRight",
    when: { mac: true, terminal: false, commandCenter: false },
    help: {
      id: "workspace-pane-move-tab-right",
      section: "global",
      label: "Move tab right",
      keys: ["mod", "shift", "alt", "Right"],
    },
  },
  {
    id: "workspace-pane-move-tab-up-cmd-shift-alt-up",
    action: "workspace.pane.move-tab.up",
    combo: "Cmd+Alt+Shift+ArrowUp",
    when: { mac: true, terminal: false, commandCenter: false },
    help: {
      id: "workspace-pane-move-tab-up",
      section: "global",
      label: "Move tab up",
      keys: ["mod", "shift", "alt", "Up"],
    },
  },
  {
    id: "workspace-pane-move-tab-down-cmd-shift-alt-down",
    action: "workspace.pane.move-tab.down",
    combo: "Cmd+Alt+Shift+ArrowDown",
    when: { mac: true, terminal: false, commandCenter: false },
    help: {
      id: "workspace-pane-move-tab-down",
      section: "global",
      label: "Move tab down",
      keys: ["mod", "shift", "alt", "Down"],
    },
  },
  {
    id: "workspace-pane-close-cmd-shift-w",
    action: "workspace.pane.close",
    combo: "Cmd+Shift+W",
    when: { mac: true, terminal: false, commandCenter: false },
    help: {
      id: "workspace-pane-close",
      section: "global",
      label: "Close pane",
      keys: ["mod", "shift", "W"],
    },
  },

  // --- Command center ---
  {
    id: "command-center-toggle-cmd-k-mac",
    action: "command-center.toggle",
    combo: "Cmd+K",
    when: { mac: true },
    help: {
      id: "toggle-command-center",
      section: "global",
      label: "Toggle command center",
      keys: ["mod", "K"],
    },
  },
  {
    id: "command-center-toggle-ctrl-k-non-mac",
    action: "command-center.toggle",
    combo: "Ctrl+K",
    when: { mac: false, terminal: false },
    help: {
      id: "toggle-command-center",
      section: "global",
      label: "Toggle command center",
      keys: ["mod", "K"],
    },
  },

  // --- Keyboard shortcuts dialog ---
  {
    id: "shortcuts-dialog-toggle-question-mark",
    action: "shortcuts.dialog.toggle",
    combo: "Shift+?",
    repeat: false,
    when: { focusScope: "other" },
    help: {
      id: "show-shortcuts",
      section: "global",
      label: "Show keyboard shortcuts",
      keys: ["?"],
      note: "Available when focus is not in a text field or terminal.",
    },
  },

  // --- Sidebar toggles ---
  {
    id: "sidebar-toggle-left-mac-cmd-b",
    action: "sidebar.toggle.left",
    combo: "Cmd+B",
    when: { mac: true },
    help: {
      id: "toggle-left-sidebar",
      section: "global",
      label: "Toggle left sidebar",
      keys: ["mod", "B"],
    },
  },
  {
    id: "sidebar-toggle-left-cmd-period-mac",
    action: "sidebar.toggle.left",
    combo: "Cmd+.",
    when: { mac: true, commandCenter: false },
  },
  {
    id: "sidebar-toggle-left-ctrl-period-non-mac",
    action: "sidebar.toggle.left",
    combo: "Ctrl+.",
    when: { mac: false, commandCenter: false, terminal: false },
    help: {
      id: "toggle-left-sidebar",
      section: "global",
      label: "Toggle left sidebar",
      keys: ["mod", "."],
    },
  },
  {
    id: "sidebar-toggle-right-cmd-e-mac",
    action: "sidebar.toggle.right",
    combo: "Cmd+E",
    when: { mac: true, hasSelectedAgent: true, commandCenter: false },
    help: {
      id: "toggle-right-sidebar",
      section: "global",
      label: "Toggle right sidebar",
      keys: ["mod", "E"],
    },
  },
  {
    id: "sidebar-toggle-right-ctrl-e-non-mac",
    action: "sidebar.toggle.right",
    combo: "Ctrl+E",
    when: { mac: false, hasSelectedAgent: true, commandCenter: false, terminal: false },
    help: {
      id: "toggle-right-sidebar",
      section: "global",
      label: "Toggle right sidebar",
      keys: ["mod", "E"],
    },
  },
  {
    id: "sidebar-toggle-right-ctrl-backquote",
    action: "sidebar.toggle.right",
    combo: "Ctrl+`",
    when: { hasSelectedAgent: true, commandCenter: false },
  },

  // --- Message input ---
  {
    id: "message-input-voice-toggle-cmd-shift-d-mac",
    action: "message-input.action",
    combo: "Cmd+Shift+D",
    repeat: false,
    when: { mac: true, commandCenter: false, terminal: false },
    payload: { type: "message-input", kind: "voice-toggle" },
    help: {
      id: "voice-toggle",
      section: "agent-input",
      label: "Toggle voice mode",
      keys: ["mod", "shift", "D"],
    },
  },
  {
    id: "message-input-voice-toggle-ctrl-shift-d-non-mac",
    action: "message-input.action",
    combo: "Ctrl+Shift+D",
    repeat: false,
    when: { mac: false, commandCenter: false, terminal: false },
    payload: { type: "message-input", kind: "voice-toggle" },
    help: {
      id: "voice-toggle",
      section: "agent-input",
      label: "Toggle voice mode",
      keys: ["mod", "shift", "D"],
    },
  },
  {
    id: "message-input-dictation-toggle-cmd-d-mac",
    action: "message-input.action",
    combo: "Cmd+D",
    when: { mac: true, commandCenter: false, terminal: false },
    payload: { type: "message-input", kind: "dictation-toggle" },
    help: {
      id: "dictation-toggle",
      section: "agent-input",
      label: "Start/stop dictation",
      keys: ["mod", "D"],
    },
  },
  {
    id: "message-input-dictation-toggle-ctrl-d-non-mac",
    action: "message-input.action",
    combo: "Ctrl+D",
    when: { mac: false, commandCenter: false, terminal: false },
    payload: { type: "message-input", kind: "dictation-toggle" },
    help: {
      id: "dictation-toggle",
      section: "agent-input",
      label: "Start/stop dictation",
      keys: ["mod", "D"],
    },
  },
  {
    id: "message-input-dictation-cancel",
    action: "message-input.action",
    combo: "Escape",
    when: { commandCenter: false, terminal: false },
    payload: { type: "message-input", kind: "dictation-cancel" },
    preventDefault: false,
    stopPropagation: false,
    help: {
      id: "dictation-cancel",
      section: "agent-input",
      label: "Cancel dictation",
      keys: ["Esc"],
    },
  },
  {
    id: "message-input-voice-mute-toggle",
    action: "message-input.action",
    combo: "Space",
    repeat: false,
    when: { commandCenter: false, focusScope: "other" },
    payload: { type: "message-input", kind: "voice-mute-toggle" },
    help: {
      id: "voice-mute-toggle",
      section: "agent-input",
      label: "Mute/unmute voice mode",
      keys: ["Space"],
    },
  },
];

// --- Parse bindings at module load ---

function parseBinding(binding: ShortcutBinding): ParsedShortcutBinding {
  const parsedCombo = parseShortcutString(binding.combo);
  if (binding.repeat === false) {
    parsedCombo.repeat = false;
  }
  return { ...binding, parsedCombo };
}

export const DEFAULT_BINDINGS: readonly ParsedShortcutBinding[] =
  SHORTCUT_BINDINGS.map(parseBinding);

export function buildEffectiveBindings(
  overrides: Record<string, string>,
): ParsedShortcutBinding[] {
  return DEFAULT_BINDINGS.map(function (binding) {
    const override = overrides[binding.id];
    if (override === undefined) {
      return binding;
    }
    let parsedCombo: KeyCombo;
    try {
      parsedCombo = parseShortcutString(override);
    } catch {
      return binding;
    }
    if (binding.repeat === false) {
      parsedCombo.repeat = false;
    }
    return { ...binding, combo: override, parsedCombo };
  });
}

// --- Matching engine ---

function parseDigit(event: KeyboardEvent): number | null {
  const code = event.code ?? "";
  if (code.startsWith("Digit")) {
    const value = Number(code.slice("Digit".length));
    return Number.isFinite(value) && value >= 1 && value <= 9 ? value : null;
  }
  if (code.startsWith("Numpad")) {
    const value = Number(code.slice("Numpad".length));
    return Number.isFinite(value) && value >= 1 && value <= 9 ? value : null;
  }
  const key = event.key ?? "";
  if (key >= "1" && key <= "9") {
    return Number(key);
  }
  return null;
}

function matchesCombo(combo: KeyCombo, event: KeyboardEvent, isMac: boolean): boolean {
  if (combo.mod) {
    if (isMac) {
      if (!event.metaKey) return false;
      if (!!combo.ctrl !== event.ctrlKey) return false;
    } else {
      if (!event.ctrlKey) return false;
      if (!!combo.meta !== event.metaKey) return false;
    }
  } else {
    if (!!combo.meta !== event.metaKey) return false;
    if (!!combo.ctrl !== event.ctrlKey) return false;
  }
  if (!!combo.alt !== event.altKey) return false;
  if (!!combo.shift !== event.shiftKey) return false;
  if (combo.repeat === false && event.repeat) return false;

  if (combo.code === "Digit") {
    return parseDigit(event) !== null;
  }

  const codeMatch = event.code === combo.code;
  const keyMatch = combo.key !== undefined && event.key.toLowerCase() === combo.key.toLowerCase();
  return codeMatch || keyMatch;
}

function matchesWhen(when: ShortcutWhen | undefined, context: KeyboardShortcutContext): boolean {
  if (!when) return true;
  if (when.mac !== undefined && when.mac !== context.isMac) return false;
  if (when.desktop !== undefined && when.desktop !== context.isDesktop) return false;
  if (when.terminal === false && context.focusScope === "terminal") return false;
  if (when.commandCenter === false && context.commandCenterOpen) return false;
  if (when.hasSelectedAgent === true && !context.hasSelectedAgent) return false;
  if (when.focusScope !== undefined && context.focusScope !== when.focusScope) return false;
  return true;
}

function resolvePayload(
  def: ShortcutPayloadDef | undefined,
  event: KeyboardEvent,
): KeyboardShortcutPayload {
  if (!def) return null;
  switch (def.type) {
    case "index": {
      const index = parseDigit(event);
      return index ? { index } : null;
    }
    case "delta":
      return { delta: def.delta };
    case "message-input":
      return { kind: def.kind };
  }
}

function helpMatchesPlatform(
  when: ShortcutWhen | undefined,
  context: KeyboardShortcutPlatformContext,
): boolean {
  if (when?.mac !== undefined && when.mac !== context.isMac) return false;
  if (when?.desktop !== undefined && when.desktop !== context.isDesktop) return false;
  return true;
}

// --- Public API ---

export function resolveKeyboardShortcut(input: {
  event: KeyboardEvent;
  context: KeyboardShortcutContext;
  bindings?: readonly ParsedShortcutBinding[];
}): KeyboardShortcutMatch | null {
  const { event, context, bindings = DEFAULT_BINDINGS } = input;
  for (const binding of bindings) {
    if (!matchesCombo(binding.parsedCombo, event, context.isMac)) {
      continue;
    }
    if (!matchesWhen(binding.when, context)) {
      continue;
    }
    return {
      action: binding.action,
      payload: resolvePayload(binding.payload, event),
      preventDefault: binding.preventDefault ?? true,
      stopPropagation: binding.stopPropagation ?? true,
    };
  }
  return null;
}

export function getBindingIdForAction(
  actionId: string,
  platform: { isMac: boolean; isDesktop: boolean },
): string | null {
  for (const binding of DEFAULT_BINDINGS) {
    if (binding.help?.id !== actionId) {
      continue;
    }
    if (!helpMatchesPlatform(binding.when, platform)) {
      continue;
    }
    return binding.id;
  }
  return null;
}

export function getDefaultKeysForAction(
  actionId: string,
  platform: { isMac: boolean; isDesktop: boolean },
): ShortcutKey[] | null {
  for (const binding of DEFAULT_BINDINGS) {
    if (binding.help?.id !== actionId) {
      continue;
    }
    if (!helpMatchesPlatform(binding.when, platform)) {
      continue;
    }
    return binding.help.keys;
  }
  return null;
}

export function buildKeyboardShortcutHelpSections(
  input: KeyboardShortcutPlatformContext,
  bindings: readonly ParsedShortcutBinding[] = DEFAULT_BINDINGS,
): KeyboardShortcutHelpSection[] {
  const seenRows = new Set<string>();
  const rowsBySection = new Map<KeyboardShortcutHelpSection["id"], KeyboardShortcutHelpRow[]>([
    ["global", []],
    ["agent-input", []],
  ]);

  for (const binding of bindings) {
    const help = binding.help;
    if (!help) {
      continue;
    }
    if (!helpMatchesPlatform(binding.when, input)) {
      continue;
    }
    const rowKey = `${help.section}:${help.id}`;
    if (seenRows.has(rowKey)) {
      continue;
    }
    seenRows.add(rowKey);

    const rows = rowsBySection.get(help.section);
    if (!rows) {
      continue;
    }
    rows.push({
      id: help.id,
      label: help.label,
      keys: help.keys,
      ...(help.note ? { note: help.note } : {}),
    });
  }

  const sectionOrder: KeyboardShortcutHelpSection["id"][] = ["global", "agent-input"];

  return sectionOrder.flatMap((sectionId) => {
    const rows = rowsBySection.get(sectionId) ?? [];
    if (rows.length === 0) {
      return [];
    }
    return [
      {
        id: sectionId,
        title: SHORTCUT_HELP_SECTION_TITLES[sectionId],
        rows,
      },
    ];
  });
}

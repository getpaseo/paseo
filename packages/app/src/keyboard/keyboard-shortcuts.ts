import type { ShortcutKey } from "@/utils/format-shortcut";
import type {
  KeyboardActionId,
  KeyboardFocusScope,
  KeyboardShortcutPayload,
  MessageInputKeyboardActionKind,
} from "@/keyboard/actions";
import { type KeyCombo, parseChordString } from "@/keyboard/shortcut-string";
import { chordStringToShortcutKeys } from "@/keyboard/shortcut-string";

export type { KeyCombo } from "@/keyboard/shortcut-string";

// --- Public types ---

export interface KeyboardShortcutContext {
  isMac: boolean;
  isDesktop: boolean;
  focusScope: KeyboardFocusScope;
  commandCenterOpen: boolean;
}

export interface KeyboardShortcutInput {
  key: string;
  code: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
}

export interface KeyboardShortcutMatch {
  action: KeyboardActionId;
  commandShortcutId?: string;
  payload: KeyboardShortcutPayload;
  preventDefault: boolean;
  stopPropagation: boolean;
}

export interface KeyboardShortcutHelpRow {
  id: string;
  label: string;
  labelKey: string;
  keys: ShortcutKey[];
  chord?: ShortcutKey[][] | null;
  note?: string;
  noteKey?: string;
}

export type ShortcutSectionId = "general" | "workspaces" | "tabs-panes" | "layout" | "agent-input";

export interface KeyboardShortcutHelpSection {
  id: ShortcutSectionId;
  title: string;
  titleKey: string;
  rows: KeyboardShortcutHelpRow[];
}

// --- Binding definition types ---

interface KeyboardShortcutPlatformContext {
  isMac: boolean;
  isDesktop: boolean;
}

interface ShortcutWhen {
  /** true = mac only, false = non-mac only */
  mac?: boolean;
  /** true = desktop only, false = web only */
  desktop?: boolean;
  /** false = disabled when a text-editing surface is focused */
  editable?: false;
  /** false = disabled when terminal is focused */
  terminal?: false;
  /** false = disabled when command center is open */
  commandCenter?: false;
  /** Allowed focus scope or scopes */
  focusScope?: KeyboardFocusScope | readonly KeyboardFocusScope[];
}

type ShortcutPayloadDef =
  | { type: "index" }
  | { type: "delta"; delta: 1 | -1 }
  | { type: "message-input"; kind: MessageInputKeyboardActionKind };

interface ShortcutHelp {
  id: string;
  section: ShortcutSectionId;
  label: string;
  keys?: ShortcutKey[];
  defaultDisplayKeys?: ShortcutKey[];
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
  parsedChord: KeyCombo[];
  commandShortcutId?: string;
}

export interface ChordState {
  candidateIndices: number[];
  step: number;
  timeoutId: ReturnType<typeof setTimeout> | null;
}

// --- Constants ---

// Sections are listed in this order, most-reached-for first.
const SHORTCUT_HELP_SECTION_ORDER: readonly ShortcutSectionId[] = [
  "general",
  "workspaces",
  "tabs-panes",
  "layout",
  "agent-input",
];

const SHORTCUT_HELP_SECTION_TITLES: Record<ShortcutSectionId, string> = {
  general: "General",
  workspaces: "Projects & Workspaces",
  "tabs-panes": "Tabs & Panes",
  layout: "Layout",
  "agent-input": "Agent Input",
};

const SHORTCUT_HELP_SECTION_LABEL_KEYS: Record<ShortcutSectionId, string> = {
  general: "settings.shortcuts.sections.general",
  workspaces: "settings.shortcuts.sections.workspaces",
  "tabs-panes": "settings.shortcuts.sections.tabsPanes",
  layout: "settings.shortcuts.sections.layout",
  "agent-input": "settings.shortcuts.sections.agentInput",
};

// Rows render in this order rather than in binding-definition order, so the shortcut someone opens
// this sheet to find sits at the top of its section. Every help id must appear here; the unit test
// fails when a new shortcut is added without a place, instead of silently sinking to the bottom.
export const SHORTCUT_HELP_ROW_ORDER: Record<ShortcutSectionId, readonly string[]> = {
  general: [
    "toggle-command-center",
    "search-files",
    "show-shortcuts",
    "toggle-settings",
    "cycle-theme",
  ],
  workspaces: [
    "new-agent",
    "new-workspace",
    "workspace-jump-index",
    "workspace-prev",
    "workspace-next",
    "pin-workspace",
    "archive-workspace",
  ],
  "tabs-panes": [
    "workspace-tab-new",
    "workspace-tab-target-agent",
    "workspace-terminal-new",
    "workspace-tab-target-browser",
    "workspace-tab-target-changes",
    "workspace-tab-target-files",
    "workspace-tab-close-current",
    "workspace-tab-jump-index",
    "workspace-tab-prev",
    "workspace-tab-next",
    "workspace-pane-split-right",
    "workspace-pane-split-down",
    "workspace-pane-focus-left",
    "workspace-pane-focus-right",
    "workspace-pane-focus-up",
    "workspace-pane-focus-down",
    "workspace-pane-move-tab-left",
    "workspace-pane-move-tab-right",
    "workspace-pane-move-tab-up",
    "workspace-pane-move-tab-down",
    "workspace-pane-close",
  ],
  layout: ["toggle-left-sidebar", "toggle-right-sidebar", "toggle-both-sidebars", "toggle-focus"],
  "agent-input": [
    "focus-message-input",
    "cycle-agent-mode",
    "voice-toggle",
    "dictation-toggle",
    "agent-interrupt",
    "voice-mute-toggle",
  ],
};

const SHORTCUT_HELP_LABEL_KEYS: Record<string, string> = {
  "new-agent": "settings.shortcuts.help.openProject",
  "new-workspace": "settings.shortcuts.help.newWorkspace",
  "switch-project": "settings.shortcuts.help.switchProject",
  "archive-workspace": "settings.shortcuts.help.archiveWorkspace",
  "workspace-tab-new": "settings.shortcuts.help.newTab",
  "workspace-tab-target-agent": "workspace.tabs.actions.newAgent",
  "workspace-tab-target-browser": "workspace.tabs.actions.newBrowser",
  "workspace-tab-target-changes": "workspace.tabs.actions.changes",
  "workspace-tab-target-files": "workspace.tabs.actions.files",
  "workspace-tab-close-current": "settings.shortcuts.help.closeCurrentTab",
  "workspace-jump-index": "settings.shortcuts.help.jumpToWorkspace",
  "workspace-tab-jump-index": "settings.shortcuts.help.jumpToTab",
  "workspace-prev": "settings.shortcuts.help.previousWorkspace",
  "workspace-next": "settings.shortcuts.help.nextWorkspace",
  "workspace-tab-prev": "settings.shortcuts.help.previousTab",
  "workspace-tab-next": "settings.shortcuts.help.nextTab",
  "workspace-pane-split-right": "settings.shortcuts.help.splitPaneRight",
  "workspace-pane-split-down": "settings.shortcuts.help.splitPaneDown",
  "workspace-pane-focus-left": "settings.shortcuts.help.focusPaneLeft",
  "workspace-pane-focus-right": "settings.shortcuts.help.focusPaneRight",
  "workspace-pane-focus-up": "settings.shortcuts.help.focusPaneUp",
  "workspace-pane-focus-down": "settings.shortcuts.help.focusPaneDown",
  "workspace-pane-move-tab-left": "settings.shortcuts.help.moveTabLeft",
  "workspace-pane-move-tab-right": "settings.shortcuts.help.moveTabRight",
  "workspace-pane-move-tab-up": "settings.shortcuts.help.moveTabUp",
  "workspace-pane-move-tab-down": "settings.shortcuts.help.moveTabDown",
  "workspace-pane-close": "settings.shortcuts.help.closePane",
  "workspace-terminal-new": "settings.shortcuts.help.newTerminal",
  "search-files": "settings.shortcuts.help.searchFiles",
  "toggle-command-center": "settings.shortcuts.help.toggleCommandCenter",
  "show-shortcuts": "settings.shortcuts.help.showKeyboardShortcuts",
  "toggle-left-sidebar": "settings.shortcuts.help.toggleLeftSidebar",
  "toggle-right-sidebar": "settings.shortcuts.help.toggleRightSidebar",
  "toggle-both-sidebars": "settings.shortcuts.help.toggleBothSidebars",
  "toggle-settings": "settings.shortcuts.help.toggleSettings",
  "toggle-focus": "settings.shortcuts.help.toggleFocusMode",
  "cycle-theme": "settings.shortcuts.help.cycleTheme",
  "focus-message-input": "settings.shortcuts.help.focusMessageInput",
  "cycle-agent-mode": "settings.shortcuts.help.cycleAgentMode",
  "voice-toggle": "settings.shortcuts.help.toggleVoiceMode",
  "dictation-toggle": "settings.shortcuts.help.startStopDictation",
  "agent-interrupt": "settings.shortcuts.help.interruptAgent",
  "voice-mute-toggle": "settings.shortcuts.help.muteUnmuteVoiceMode",
};

const SHORTCUT_HELP_NOTE_KEYS: Record<string, string> = {
  "show-shortcuts": "settings.shortcuts.helpNotes.showKeyboardShortcuts",
};

// --- Binding definitions ---

const SHORTCUT_BINDINGS: readonly ShortcutBinding[] = [
  // --- Open project ---
  // Open project moved from Cmd+Shift+O to Cmd+O. The binding ids intentionally
  // keep their original "cmd-shift-o" / "ctrl-shift-o" names: user shortcut
  // overrides are keyed by binding id, so renaming them would silently drop a
  // user's customized Open project shortcut on upgrade.
  {
    id: "agent-new-cmd-shift-o-mac",
    action: "agent.new",
    combo: "Cmd+O",
    when: { mac: true },
    help: {
      id: "new-agent",
      section: "workspaces",
      label: "Open project",
      keys: ["mod", "O"],
    },
  },
  {
    id: "agent-new-ctrl-shift-o-non-mac",
    action: "agent.new",
    combo: "Ctrl+O",
    when: { mac: false, terminal: false },
    help: {
      id: "new-agent",
      section: "workspaces",
      label: "Open project",
      keys: ["mod", "O"],
    },
  },

  // --- New workspace ---
  {
    id: "workspace-new-cmd-n-mac",
    action: "workspace.new",
    combo: "Cmd+N",
    when: { mac: true, commandCenter: false },
    help: {
      id: "new-workspace",
      section: "workspaces",
      label: "New workspace",
      keys: ["mod", "N"],
    },
  },
  {
    id: "workspace-new-ctrl-n-non-mac",
    action: "workspace.new",
    combo: "Ctrl+N",
    when: { mac: false, commandCenter: false, terminal: false },
    help: {
      id: "new-workspace",
      section: "workspaces",
      label: "New workspace",
      keys: ["mod", "N"],
    },
  },

  // --- Search files (switch project on the New Workspace screen) ---
  {
    id: "workspace-project-pick-cmd-p-mac",
    action: "command-center.files",
    combo: "Cmd+P",
    when: { mac: true, commandCenter: false },
    help: {
      id: "search-files",
      section: "general",
      label: "Search files",
      keys: ["mod", "P"],
    },
  },
  {
    id: "workspace-project-pick-ctrl-p-non-mac",
    action: "command-center.files",
    combo: "Ctrl+P",
    when: { mac: false, commandCenter: false, terminal: false },
    help: {
      id: "search-files",
      section: "general",
      label: "Search files",
      keys: ["mod", "P"],
    },
  },

  // --- Archive workspace ---
  {
    // COMPAT(workspaceArchiveShortcutOverride): added in v0.1.106; remove after
    // 2027-01-11 with a stored-override migration. Keeps existing custom chords.
    id: "worktree-archive-cmd-shift-backspace-mac",
    action: "workspace.archive",
    combo: "Cmd+Shift+Backspace",
    when: { mac: true, commandCenter: false },
    help: {
      id: "archive-workspace",
      section: "workspaces",
      label: "Archive workspace",
      keys: ["mod", "shift", "Backspace"],
    },
  },
  {
    // COMPAT(workspaceArchiveShortcutOverride): added in v0.1.106; remove after
    // 2027-01-11 with a stored-override migration. Keeps existing custom chords.
    id: "worktree-archive-ctrl-shift-backspace-non-mac",
    action: "workspace.archive",
    combo: "Ctrl+Shift+Backspace",
    when: { mac: false, commandCenter: false, terminal: false },
    help: {
      id: "archive-workspace",
      section: "workspaces",
      label: "Archive workspace",
      keys: ["mod", "shift", "Backspace"],
    },
  },

  // --- Pin workspace ---
  {
    id: "workspace-pin-cmd-shift-p-mac",
    action: "workspace.pin",
    combo: "Cmd+Shift+P",
    when: { mac: true, commandCenter: false },
    help: {
      id: "pin-workspace",
      section: "workspaces",
      label: "Pin chat",
      keys: ["mod", "shift", "P"],
    },
  },
  {
    id: "workspace-pin-ctrl-shift-p-non-mac",
    action: "workspace.pin",
    combo: "Ctrl+Shift+P",
    when: { mac: false, commandCenter: false, terminal: false },
    help: {
      id: "pin-workspace",
      section: "workspaces",
      label: "Pin chat",
      keys: ["mod", "shift", "P"],
    },
  },

  // --- Tab management ---
  {
    id: "workspace-tab-new-cmd-t-mac",
    action: "workspace.tab.menu.open",
    combo: "Cmd+T",
    when: { mac: true, commandCenter: false },
    help: {
      id: "workspace-tab-new",
      section: "tabs-panes",
      label: "New tab",
      keys: ["mod", "T"],
    },
  },
  {
    id: "workspace-tab-new-ctrl-t-non-mac",
    action: "workspace.tab.menu.open",
    combo: "Ctrl+T",
    when: { mac: false, commandCenter: false, terminal: false },
    help: {
      id: "workspace-tab-new",
      section: "tabs-panes",
      label: "New tab",
      keys: ["mod", "T"],
    },
  },
  {
    id: "workspace-tab-target-agent-cmd-shift-a-mac",
    action: "workspace.tab.target.agent",
    combo: "Cmd+Shift+A",
    when: { mac: true, commandCenter: false },
    help: {
      id: "workspace-tab-target-agent",
      section: "tabs-panes",
      label: "New agent",
    },
  },
  {
    id: "workspace-tab-target-agent-ctrl-shift-a-non-mac",
    action: "workspace.tab.target.agent",
    combo: "Ctrl+Shift+A",
    when: { mac: false, commandCenter: false, terminal: false },
    help: {
      id: "workspace-tab-target-agent",
      section: "tabs-panes",
      label: "New agent",
    },
  },
  {
    id: "workspace-tab-target-browser-cmd-shift-b-mac",
    action: "workspace.tab.target.browser",
    combo: "Cmd+Shift+B",
    when: { mac: true, commandCenter: false },
    help: {
      id: "workspace-tab-target-browser",
      section: "tabs-panes",
      label: "New browser",
    },
  },
  {
    id: "workspace-tab-target-browser-ctrl-shift-b-non-mac",
    action: "workspace.tab.target.browser",
    combo: "Ctrl+Shift+B",
    when: { mac: false, commandCenter: false, terminal: false },
    help: {
      id: "workspace-tab-target-browser",
      section: "tabs-panes",
      label: "New browser",
    },
  },
  {
    // Keep the binding id stable so saved overrides from the former Cmd+Shift+C default survive.
    id: "workspace-tab-target-changes-cmd-shift-c-mac",
    action: "workspace.tab.target.changes",
    combo: "Cmd+Shift+G",
    when: { mac: true, commandCenter: false },
    help: {
      id: "workspace-tab-target-changes",
      section: "tabs-panes",
      label: "Changes",
    },
  },
  {
    // Keep the binding id stable so saved overrides from the former Ctrl+Shift+C default survive.
    id: "workspace-tab-target-changes-ctrl-shift-c-non-mac",
    action: "workspace.tab.target.changes",
    combo: "Ctrl+Shift+G",
    when: { mac: false, commandCenter: false, terminal: false },
    help: {
      id: "workspace-tab-target-changes",
      section: "tabs-panes",
      label: "Changes",
    },
  },
  {
    id: "workspace-tab-target-files-cmd-shift-e-mac",
    action: "workspace.tab.target.files",
    combo: "Cmd+Shift+E",
    when: { mac: true, commandCenter: false },
    help: {
      id: "workspace-tab-target-files",
      section: "tabs-panes",
      label: "Files",
    },
  },
  {
    id: "workspace-tab-target-files-ctrl-shift-e-non-mac",
    action: "workspace.tab.target.files",
    combo: "Ctrl+Shift+E",
    when: { mac: false, commandCenter: false, terminal: false },
    help: {
      id: "workspace-tab-target-files",
      section: "tabs-panes",
      label: "Files",
    },
  },
  {
    id: "workspace-tab-close-current-cmd-w-mac",
    action: "workspace.tab.close.current",
    combo: "Cmd+W",
    when: { mac: true, desktop: true, commandCenter: false },
    help: {
      id: "workspace-tab-close-current",
      section: "tabs-panes",
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
      section: "tabs-panes",
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
      section: "tabs-panes",
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
      section: "workspaces",
      label: "Jump to workspace",
      keys: ["mod", "1-9"],
      defaultDisplayKeys: ["mod", "1-9"],
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
      section: "workspaces",
      label: "Jump to workspace",
      keys: ["mod", "1-9"],
      defaultDisplayKeys: ["mod", "1-9"],
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
      section: "workspaces",
      label: "Jump to workspace",
      keys: ["alt", "1-9"],
      defaultDisplayKeys: ["alt", "1-9"],
    },
  },

  // --- Tab index jump ---
  {
    id: "workspace-tab-navigate-index-cmd-alt-digit-mac-desktop",
    action: "workspace.tab.navigate.index",
    combo: "Cmd+Alt+Digit",
    when: { mac: true, desktop: true, commandCenter: false },
    payload: { type: "index" },
    help: {
      id: "workspace-tab-jump-index",
      section: "tabs-panes",
      label: "Jump to tab",
      keys: ["mod", "alt", "1-9"],
      defaultDisplayKeys: ["mod", "alt", "1-9"],
    },
  },
  {
    id: "workspace-tab-navigate-index-alt-digit-desktop",
    action: "workspace.tab.navigate.index",
    combo: "Alt+Digit",
    when: { mac: false, desktop: true, commandCenter: false },
    payload: { type: "index" },
    help: {
      id: "workspace-tab-jump-index",
      section: "tabs-panes",
      label: "Jump to tab",
      keys: ["alt", "1-9"],
      defaultDisplayKeys: ["alt", "1-9"],
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
      section: "tabs-panes",
      label: "Jump to tab",
      keys: ["alt", "shift", "1-9"],
      defaultDisplayKeys: ["alt", "shift", "1-9"],
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
      section: "workspaces",
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
      section: "workspaces",
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
      section: "workspaces",
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
      section: "workspaces",
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
      section: "workspaces",
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
      section: "workspaces",
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
      section: "tabs-panes",
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
      section: "tabs-panes",
      label: "Next tab",
      keys: ["alt", "shift", "]"],
    },
  },

  // --- Pane management (mac only) ---
  {
    id: "workspace-pane-split-right-cmd-backslash",
    action: "workspace.pane.split.right",
    combo: "Cmd+\\",
    when: { mac: true, commandCenter: false },
    help: {
      id: "workspace-pane-split-right",
      section: "tabs-panes",
      label: "Split pane right",
      keys: ["mod", "\\"],
    },
  },
  {
    id: "workspace-pane-split-down-cmd-shift-backslash",
    action: "workspace.pane.split.down",
    combo: "Cmd+Shift+\\",
    when: { mac: true, commandCenter: false },
    help: {
      id: "workspace-pane-split-down",
      section: "tabs-panes",
      label: "Split pane down",
      keys: ["mod", "shift", "\\"],
    },
  },
  {
    id: "workspace-pane-focus-left-cmd-shift-left",
    action: "workspace.pane.focus.left",
    combo: "Cmd+Shift+ArrowLeft",
    when: { mac: true, commandCenter: false, editable: false },
    help: {
      id: "workspace-pane-focus-left",
      section: "tabs-panes",
      label: "Focus pane left",
      keys: ["mod", "shift", "Left"],
    },
  },
  {
    id: "workspace-pane-focus-right-cmd-shift-right",
    action: "workspace.pane.focus.right",
    combo: "Cmd+Shift+ArrowRight",
    when: { mac: true, commandCenter: false, editable: false },
    help: {
      id: "workspace-pane-focus-right",
      section: "tabs-panes",
      label: "Focus pane right",
      keys: ["mod", "shift", "Right"],
    },
  },
  {
    id: "workspace-pane-focus-up-cmd-shift-up",
    action: "workspace.pane.focus.up",
    combo: "Cmd+Shift+ArrowUp",
    when: { mac: true, commandCenter: false, editable: false },
    help: {
      id: "workspace-pane-focus-up",
      section: "tabs-panes",
      label: "Focus pane up",
      keys: ["mod", "shift", "Up"],
    },
  },
  {
    id: "workspace-pane-focus-down-cmd-shift-down",
    action: "workspace.pane.focus.down",
    combo: "Cmd+Shift+ArrowDown",
    when: { mac: true, commandCenter: false, editable: false },
    help: {
      id: "workspace-pane-focus-down",
      section: "tabs-panes",
      label: "Focus pane down",
      keys: ["mod", "shift", "Down"],
    },
  },
  {
    id: "workspace-pane-move-tab-left-cmd-shift-alt-left",
    action: "workspace.pane.move-tab.left",
    combo: "Cmd+Alt+Shift+ArrowLeft",
    when: { mac: true, commandCenter: false },
    help: {
      id: "workspace-pane-move-tab-left",
      section: "tabs-panes",
      label: "Move tab left",
      keys: ["mod", "shift", "alt", "Left"],
    },
  },
  {
    id: "workspace-pane-move-tab-right-cmd-shift-alt-right",
    action: "workspace.pane.move-tab.right",
    combo: "Cmd+Alt+Shift+ArrowRight",
    when: { mac: true, commandCenter: false },
    help: {
      id: "workspace-pane-move-tab-right",
      section: "tabs-panes",
      label: "Move tab right",
      keys: ["mod", "shift", "alt", "Right"],
    },
  },
  {
    id: "workspace-pane-move-tab-up-cmd-shift-alt-up",
    action: "workspace.pane.move-tab.up",
    combo: "Cmd+Alt+Shift+ArrowUp",
    when: { mac: true, commandCenter: false },
    help: {
      id: "workspace-pane-move-tab-up",
      section: "tabs-panes",
      label: "Move tab up",
      keys: ["mod", "shift", "alt", "Up"],
    },
  },
  {
    id: "workspace-pane-move-tab-down-cmd-shift-alt-down",
    action: "workspace.pane.move-tab.down",
    combo: "Cmd+Alt+Shift+ArrowDown",
    when: { mac: true, commandCenter: false },
    help: {
      id: "workspace-pane-move-tab-down",
      section: "tabs-panes",
      label: "Move tab down",
      keys: ["mod", "shift", "alt", "Down"],
    },
  },
  {
    id: "workspace-pane-close-cmd-shift-w",
    action: "workspace.pane.close",
    combo: "Cmd+Shift+W",
    when: { mac: true, commandCenter: false },
    help: {
      id: "workspace-pane-close",
      section: "tabs-panes",
      label: "Close pane",
      keys: ["mod", "shift", "W"],
    },
  },
  // --- New terminal ---
  {
    id: "workspace-terminal-new-cmd-shift-t-mac",
    action: "workspace.terminal.new",
    combo: "Cmd+Shift+T",
    when: { mac: true, commandCenter: false },
    help: {
      id: "workspace-terminal-new",
      section: "tabs-panes",
      label: "New terminal",
      keys: ["mod", "shift", "T"],
    },
  },
  {
    id: "workspace-terminal-new-ctrl-shift-t-non-mac",
    action: "workspace.terminal.new",
    combo: "Ctrl+Shift+T",
    when: { mac: false, commandCenter: false, terminal: false },
    help: {
      id: "workspace-terminal-new",
      section: "tabs-panes",
      label: "New terminal",
      keys: ["mod", "shift", "T"],
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
      section: "general",
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
      section: "general",
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
      section: "general",
      label: "Show keyboard shortcuts",
      keys: ["?"],
      defaultDisplayKeys: ["?"],
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
      section: "layout",
      label: "Toggle left sidebar",
      keys: ["mod", "B"],
    },
  },
  {
    id: "sidebar-toggle-left-ctrl-period-non-mac",
    action: "sidebar.toggle.left",
    combo: "Ctrl+B",
    when: { mac: false, commandCenter: false, terminal: false },
    help: {
      id: "toggle-left-sidebar",
      section: "layout",
      label: "Toggle left sidebar",
      keys: ["mod", "B"],
    },
  },
  {
    id: "sidebar-toggle-right-cmd-e-mac",
    action: "sidebar.toggle.right",
    combo: "Cmd+E",
    when: { mac: true, commandCenter: false },
    help: {
      id: "toggle-right-sidebar",
      section: "layout",
      label: "Toggle Explorer sidebar",
      keys: ["mod", "E"],
    },
  },
  {
    id: "sidebar-toggle-right-ctrl-e-non-mac",
    action: "sidebar.toggle.right",
    combo: "Ctrl+E",
    when: { mac: false, commandCenter: false, terminal: false },
    help: {
      id: "toggle-right-sidebar",
      section: "layout",
      label: "Toggle Explorer sidebar",
      keys: ["mod", "E"],
    },
  },
  {
    id: "sidebar-toggle-right-ctrl-backquote",
    action: "sidebar.toggle.right",
    combo: "Ctrl+`",
    when: { commandCenter: false },
  },

  // --- Toggle both sidebars ---
  {
    id: "sidebar-toggle-both-cmd-period-mac",
    action: "sidebar.toggle.both",
    combo: "Cmd+.",
    when: { mac: true, commandCenter: false },
    help: {
      id: "toggle-both-sidebars",
      section: "layout",
      label: "Toggle both sidebars",
      keys: ["mod", "."],
    },
  },
  {
    id: "sidebar-toggle-both-ctrl-period-non-mac",
    action: "sidebar.toggle.both",
    combo: "Ctrl+.",
    when: { mac: false, commandCenter: false, terminal: false },
    help: {
      id: "toggle-both-sidebars",
      section: "layout",
      label: "Toggle both sidebars",
      keys: ["mod", "."],
    },
  },

  // --- Settings toggle ---
  {
    id: "settings-toggle-cmd-comma-mac",
    action: "settings.toggle",
    combo: "Cmd+,",
    when: { mac: true, commandCenter: false },
    help: {
      id: "toggle-settings",
      section: "general",
      label: "Toggle settings",
      keys: ["mod", ","],
    },
  },
  {
    id: "settings-toggle-ctrl-comma-non-mac",
    action: "settings.toggle",
    combo: "Ctrl+,",
    when: { mac: false, commandCenter: false, terminal: false },
    help: {
      id: "toggle-settings",
      section: "general",
      label: "Toggle settings",
      keys: ["mod", ","],
    },
  },

  // --- Focus mode ---
  {
    id: "view-toggle-focus-cmd-shift-f-mac",
    action: "view.toggle.focus",
    combo: "Cmd+Shift+F",
    when: { mac: true, commandCenter: false },
    help: {
      id: "toggle-focus",
      section: "layout",
      label: "Toggle focus mode",
      keys: ["mod", "shift", "F"],
    },
  },
  {
    id: "view-toggle-focus-ctrl-shift-f-non-mac",
    action: "view.toggle.focus",
    combo: "Ctrl+Shift+F",
    when: { mac: false, commandCenter: false, terminal: false },
    help: {
      id: "toggle-focus",
      section: "layout",
      label: "Toggle focus mode",
      keys: ["mod", "shift", "F"],
    },
  },

  // --- Theme cycling ---
  {
    id: "theme-cycle-cmd-shift-t-mac",
    action: "theme.cycle",
    combo: "Cmd+Alt+T",
    when: { mac: true, commandCenter: false },
    help: {
      id: "cycle-theme",
      section: "general",
      label: "Cycle theme",
      keys: ["mod", "alt", "T"],
    },
  },
  {
    id: "theme-cycle-ctrl-alt-t-non-mac",
    action: "theme.cycle",
    combo: "Ctrl+Alt+T",
    when: { mac: false, commandCenter: false, terminal: false },
    help: {
      id: "cycle-theme",
      section: "general",
      label: "Cycle theme",
      keys: ["mod", "alt", "T"],
    },
  },

  // --- Message input ---
  {
    id: "message-input-focus-cmd-l-mac",
    action: "message-input.action",
    combo: "Cmd+L",
    when: { mac: true, commandCenter: false },
    payload: { type: "message-input", kind: "focus" },
    help: {
      id: "focus-message-input",
      section: "agent-input",
      label: "Focus message input",
      keys: ["mod", "L"],
    },
  },
  {
    id: "message-input-focus-ctrl-l-non-mac",
    action: "message-input.action",
    combo: "Ctrl+L",
    when: { mac: false, commandCenter: false, terminal: false },
    payload: { type: "message-input", kind: "focus" },
    help: {
      id: "focus-message-input",
      section: "agent-input",
      label: "Focus message input",
      keys: ["mod", "L"],
    },
  },
  {
    id: "message-input-mode-cycle-shift-tab",
    action: "message-input.action",
    combo: "Shift+Tab",
    repeat: false,
    when: { commandCenter: false, focusScope: "message-input" },
    payload: { type: "message-input", kind: "mode-cycle" },
    help: {
      id: "cycle-agent-mode",
      section: "agent-input",
      label: "Cycle agent mode",
      keys: ["shift", "Tab"],
    },
  },
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
    id: "agent-interrupt",
    action: "agent.interrupt",
    combo: "Escape",
    when: { commandCenter: false, focusScope: ["message-input", "other"] },
    preventDefault: false,
    stopPropagation: false,
    help: {
      id: "agent-interrupt",
      section: "agent-input",
      label: "Interrupt agent",
      keys: ["Esc"],
    },
  },
  {
    id: "message-input-dictation-confirm-enter",
    action: "message-input.action",
    combo: "Enter",
    when: { commandCenter: false, terminal: false },
    payload: { type: "message-input", kind: "dictation-confirm" },
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

/** The stored value meaning the user deliberately unassigned a shortcut. */
export const UNASSIGNED_COMBO = null;

export function parseBindingChord(combo: string): KeyCombo[] {
  return combo === "" ? [] : parseChordString(combo);
}

function parseBinding(binding: ShortcutBinding): ParsedShortcutBinding {
  const parsedChord = parseBindingChord(binding.combo);
  const lastCombo = parsedChord.at(-1);
  if (binding.repeat === false && lastCombo) {
    lastCombo.repeat = false;
  }
  return { ...binding, parsedChord };
}

export const DEFAULT_BINDINGS: readonly ParsedShortcutBinding[] =
  SHORTCUT_BINDINGS.map(parseBinding);

const COMMAND_SHORTCUT_BINDING_PREFIX = "command-center.shortcut:";

export function getCommandShortcutBindingId(shortcutId: string): string {
  return `${COMMAND_SHORTCUT_BINDING_PREFIX}${shortcutId}`;
}

export function getCommandShortcutIdFromBindingId(bindingId: string): string | null {
  return bindingId.startsWith(COMMAND_SHORTCUT_BINDING_PREFIX)
    ? bindingId.slice(COMMAND_SHORTCUT_BINDING_PREFIX.length)
    : null;
}

function buildCommandShortcutBindingsUnchecked(
  shortcutIds: readonly string[],
  overrides: ShortcutOverrides,
): ParsedShortcutBinding[] {
  const bindings: ParsedShortcutBinding[] = [];
  for (const shortcutId of new Set(shortcutIds)) {
    const id = getCommandShortcutBindingId(shortcutId);
    const combo = overrides[id];
    if (!combo) continue;
    let parsedChord: KeyCombo[];
    try {
      parsedChord = parseChordString(combo);
    } catch {
      continue;
    }
    const lastCombo = parsedChord.at(-1);
    if (lastCombo) lastCombo.repeat = false;
    bindings.push({
      id,
      action: "command-center.contribution.run",
      commandShortcutId: shortcutId,
      combo,
      parsedChord,
      repeat: false,
      when: { commandCenter: false, terminal: false },
    });
  }
  return bindings;
}

export function buildCommandShortcutBindings(
  shortcutIds: readonly string[],
  overrides: ShortcutOverrides,
  reservedBindings: readonly ParsedShortcutBinding[] = [],
  platform?: KeyboardShortcutPlatformContext,
): ParsedShortcutBinding[] {
  const bindings = buildCommandShortcutBindingsUnchecked(shortcutIds, overrides);
  const applicableReservedBindings = reservedBindings.filter(
    (binding) => !platform || helpMatchesPlatform(binding.when, platform),
  );
  return bindings.filter((binding) => {
    const conflictsWithDirectBinding = bindings.some(
      (other) =>
        other.id !== binding.id && shortcutChordsConflict(binding.parsedChord, other.parsedChord),
    );
    const conflictsWithReservedBinding = applicableReservedBindings.some((reserved) =>
      shortcutChordsConflict(binding.parsedChord, reserved.parsedChord),
    );
    return !conflictsWithDirectBinding && !conflictsWithReservedBinding;
  });
}

function shortcutChordsConflict(left: readonly KeyCombo[], right: readonly KeyCombo[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((combo, index) => {
    const other = right[index];
    const modifiersMatch = ["meta", "ctrl", "alt", "shift", "mod"].every(
      (modifier) =>
        Boolean(combo[modifier as keyof KeyCombo]) === Boolean(other[modifier as keyof KeyCombo]),
    );
    if (!modifiersMatch) return false;
    if (combo.code === other.code) return true;
    return (
      (combo.code === "Digit" && /^(Digit|Numpad)[1-9]$/.test(other.code)) ||
      (other.code === "Digit" && /^(Digit|Numpad)[1-9]$/.test(combo.code))
    );
  });
}

export function findKeyboardShortcutConflict(
  bindingId: string,
  combo: string,
  overrides: ShortcutOverrides,
  commandShortcutIds: readonly string[],
  platform: KeyboardShortcutPlatformContext,
): string | null {
  let candidateChord: KeyCombo[];
  try {
    candidateChord = parseChordString(combo);
  } catch {
    return null;
  }
  const nextOverrides = { ...overrides, [bindingId]: combo };
  const bindings = [
    ...buildEffectiveBindings(nextOverrides).filter((binding) =>
      helpMatchesPlatform(binding.when, platform),
    ),
    ...buildCommandShortcutBindingsUnchecked(commandShortcutIds, nextOverrides),
  ];
  return (
    bindings.find(
      (binding) =>
        binding.id !== bindingId && shortcutChordsConflict(binding.parsedChord, candidateChord),
    )?.id ?? null
  );
}

export type ShortcutOverrides = Record<string, string | null>;

export function buildEffectiveBindings(overrides: ShortcutOverrides): ParsedShortcutBinding[] {
  return DEFAULT_BINDINGS.map(function (binding) {
    const override = overrides[binding.id];
    if (override === UNASSIGNED_COMBO) {
      return { ...binding, combo: "", parsedChord: [] };
    }
    if (typeof override !== "string") {
      return binding;
    }
    let parsedChord: KeyCombo[];
    try {
      parsedChord = parseBindingChord(override);
    } catch {
      return binding;
    }
    const lastCombo = parsedChord.at(-1);
    if (binding.repeat === false && lastCombo) {
      lastCombo.repeat = false;
    }
    return { ...binding, combo: override, parsedChord };
  });
}

// --- Matching engine ---

function parseDigit(event: KeyboardShortcutInput): number | null {
  const code = event.code;
  if (code.startsWith("Digit")) {
    const value = Number(code.slice("Digit".length));
    return Number.isFinite(value) && value >= 1 && value <= 9 ? value : null;
  }
  if (code.startsWith("Numpad")) {
    const value = Number(code.slice("Numpad".length));
    return Number.isFinite(value) && value >= 1 && value <= 9 ? value : null;
  }
  const key = event.key;
  if (key >= "1" && key <= "9") {
    return Number(key);
  }
  return null;
}

function matchesKeyOrCode(combo: KeyCombo, event: KeyboardShortcutInput): boolean {
  if (combo.key === undefined) {
    return event.code === combo.code;
  }
  const eventKey = event.key.toLowerCase();
  if (eventKey === combo.key) return true;
  if (combo.shift === true && combo.shiftedKey !== undefined && eventKey === combo.shiftedKey) {
    return true;
  }
  // macOS rewrites event.key when Option is held (Option+T -> "†",
  // Option+[ -> "“"), so Alt-bound letter / bracket bindings can only
  // match by event.code. Stay key-first for non-Alt bindings so Dvorak
  // keeps its logical-character matching (e.g. Cmd+V on physical Period
  // must paste, not trigger Cmd+.).
  if (combo.alt === true && event.code === combo.code) return true;
  return combo.codeFallback === true && event.code === combo.code;
}

function matchesCombo(combo: KeyCombo, event: KeyboardShortcutInput, isMac: boolean): boolean {
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
  return matchesKeyOrCode(combo, event);
}

export function matchesKeyboardShortcutContext(
  when: ShortcutWhen | undefined,
  context: KeyboardShortcutContext,
): boolean {
  if (!when) return true;
  if (when.mac !== undefined && when.mac !== context.isMac) return false;
  if (when.desktop !== undefined && when.desktop !== context.isDesktop) return false;
  if (
    when.editable === false &&
    (context.focusScope === "message-input" || context.focusScope === "editable")
  ) {
    return false;
  }
  if (when.terminal === false && context.focusScope === "terminal") return false;
  if (when.commandCenter === false && context.commandCenterOpen) return false;
  if (
    when.focusScope !== undefined &&
    !(typeof when.focusScope === "string"
      ? context.focusScope === when.focusScope
      : when.focusScope.includes(context.focusScope))
  ) {
    return false;
  }
  return true;
}

function resolvePayload(
  def: ShortcutPayloadDef | undefined,
  event: KeyboardShortcutInput,
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
    default:
      throw new Error("unreachable");
  }
}

const CHORD_TIMEOUT_MS = 1500;

function clearChordTimeout(timeoutId: ReturnType<typeof setTimeout> | null): void {
  if (timeoutId !== null) {
    clearTimeout(timeoutId);
  }
}

function createChordTimeout(onChordReset: () => void): ReturnType<typeof setTimeout> {
  return setTimeout(onChordReset, CHORD_TIMEOUT_MS);
}

function resetChordState(input: ChordState): ChordState {
  clearChordTimeout(input.timeoutId);
  return {
    candidateIndices: [],
    step: 0,
    timeoutId: null,
  };
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

function buildMatchFromBinding(
  binding: ParsedShortcutBinding,
  event: KeyboardShortcutInput,
): KeyboardShortcutMatch {
  return {
    action: binding.action,
    ...(binding.commandShortcutId ? { commandShortcutId: binding.commandShortcutId } : {}),
    payload: resolvePayload(binding.payload, event),
    preventDefault: binding.preventDefault ?? true,
    stopPropagation: binding.stopPropagation ?? true,
  };
}

function resolveInitialChordStep(input: {
  event: KeyboardShortcutInput;
  context: KeyboardShortcutContext;
  chordState: ChordState;
  onChordReset: () => void;
  bindings: readonly ParsedShortcutBinding[];
}): {
  match: KeyboardShortcutMatch | null;
  nextChordState: ChordState;
  preventDefault: boolean;
} {
  const { event, context, chordState, onChordReset, bindings } = input;
  const advancingCandidateIndices: number[] = [];
  let singleComboMatch: KeyboardShortcutMatch | null = null;

  for (const [index, binding] of bindings.entries()) {
    const firstCombo = binding.parsedChord[0];
    if (!firstCombo) {
      continue;
    }
    if (!matchesCombo(firstCombo, event, context.isMac)) {
      continue;
    }
    if (!matchesKeyboardShortcutContext(binding.when, context)) {
      continue;
    }
    if (binding.parsedChord.length > 1) {
      advancingCandidateIndices.push(index);
      continue;
    }
    if (!singleComboMatch) {
      singleComboMatch = buildMatchFromBinding(binding, event);
    }
  }

  if (advancingCandidateIndices.length > 0) {
    return {
      match: null,
      nextChordState: {
        candidateIndices: advancingCandidateIndices,
        step: 1,
        timeoutId: createChordTimeout(onChordReset),
      },
      preventDefault: true,
    };
  }

  return {
    match: singleComboMatch,
    nextChordState: resetChordState(chordState),
    preventDefault: false,
  };
}

function resolveAdvancingChordStep(input: {
  event: KeyboardShortcutInput;
  context: KeyboardShortcutContext;
  chordState: ChordState;
  onChordReset: () => void;
  bindings: readonly ParsedShortcutBinding[];
}): {
  match: KeyboardShortcutMatch | null;
  nextChordState: ChordState;
  preventDefault: boolean;
} {
  const { event, context, chordState, onChordReset, bindings } = input;
  const matchingCandidateIndices: number[] = [];
  let completedMatch: KeyboardShortcutMatch | null = null;

  for (const index of chordState.candidateIndices) {
    const binding = bindings[index];
    if (!binding) {
      continue;
    }
    const combo = binding.parsedChord[chordState.step];
    if (!combo) {
      continue;
    }
    if (!matchesCombo(combo, event, context.isMac)) {
      continue;
    }
    if (!matchesKeyboardShortcutContext(binding.when, context)) {
      continue;
    }
    if (chordState.step + 1 === binding.parsedChord.length) {
      completedMatch = buildMatchFromBinding(binding, event);
      break;
    }
    matchingCandidateIndices.push(index);
  }

  if (completedMatch) {
    return {
      match: completedMatch,
      nextChordState: resetChordState(chordState),
      preventDefault: false,
    };
  }

  if (matchingCandidateIndices.length > 0) {
    clearChordTimeout(chordState.timeoutId);
    return {
      match: null,
      nextChordState: {
        candidateIndices: matchingCandidateIndices,
        step: chordState.step + 1,
        timeoutId: createChordTimeout(onChordReset),
      },
      preventDefault: true,
    };
  }

  return {
    match: null,
    nextChordState: resetChordState(chordState),
    preventDefault: false,
  };
}

export function resolveKeyboardShortcut(input: {
  event: KeyboardShortcutInput;
  context: KeyboardShortcutContext;
  chordState: ChordState;
  onChordReset: () => void;
  bindings?: readonly ParsedShortcutBinding[];
}): {
  match: KeyboardShortcutMatch | null;
  nextChordState: ChordState;
  preventDefault: boolean;
} {
  const { event, context, chordState, onChordReset, bindings = DEFAULT_BINDINGS } = input;
  if (chordState.step === 0) {
    return resolveInitialChordStep({ event, context, chordState, onChordReset, bindings });
  }
  return resolveAdvancingChordStep({ event, context, chordState, onChordReset, bindings });
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

function getBindingDisplayChord(binding: ParsedShortcutBinding): ShortcutKey[][] | null {
  if (binding.parsedChord.length === 0) return null;
  const defaultBinding = DEFAULT_BINDINGS.find((candidate) => candidate.id === binding.id);
  if (binding.combo === defaultBinding?.combo && binding.help?.defaultDisplayKeys) {
    return [binding.help.defaultDisplayKeys];
  }
  return chordStringToShortcutKeys(binding.combo);
}

export function getDefaultKeysForAction(
  actionId: string,
  platform: { isMac: boolean; isDesktop: boolean },
  bindings: readonly ParsedShortcutBinding[] = DEFAULT_BINDINGS,
): ShortcutKey[][] | null {
  for (const binding of bindings) {
    if (binding.help?.id !== actionId) {
      continue;
    }
    if (!helpMatchesPlatform(binding.when, platform)) {
      continue;
    }
    return getBindingDisplayChord(binding);
  }
  return null;
}

export function resolveShortcutKeysForAction(
  actionId: string,
  overrides: ShortcutOverrides,
  platform: { isMac: boolean; isDesktop: boolean },
): ShortcutKey[][] | null {
  const bindingId = getBindingIdForAction(actionId, platform);
  if (bindingId === null) return null;
  const override = overrides[bindingId];
  if (override === UNASSIGNED_COMBO || override === "") return null;
  if (typeof override === "string") {
    try {
      parseBindingChord(override);
      return chordStringToShortcutKeys(override);
    } catch {
      // Fall through to the default for malformed persisted values.
    }
  }
  const defaultKeys = getDefaultKeysForAction(actionId, platform);
  return defaultKeys;
}

/**
 * The `KeyboardEvent.key` whose hold reveals the sidebar workspace-jump number
 * badges. It must match the modifier of the active `workspace.navigate.index`
 * binding for this runtime, otherwise the badges appear for a modifier that
 * does not actually jump: Alt on web, Cmd (Meta) on desktop Mac, Ctrl on
 * desktop non-Mac.
 */
export function getWorkspaceIndexJumpModifierKey(
  platform: { isMac: boolean; isDesktop: boolean },
  bindings: readonly ParsedShortcutBinding[] = DEFAULT_BINDINGS,
): "Alt" | "Meta" | "Control" | null {
  const binding = bindings.find(
    (candidate) =>
      candidate.action === "workspace.navigate.index" &&
      helpMatchesPlatform(candidate.when, platform),
  );
  const combo = binding?.parsedChord[0];
  if (!combo || binding?.parsedChord.length !== 1 || combo.code !== "Digit") return null;
  if (combo.shift) return null;
  if (combo.mod) return platform.isMac ? "Meta" : "Control";
  if (combo.meta) return "Meta";
  if (combo.ctrl) return "Control";
  if (combo.alt) return "Alt";
  return null;
}

export function buildKeyboardShortcutHelpSections(
  input: KeyboardShortcutPlatformContext,
  bindings: readonly ParsedShortcutBinding[] = DEFAULT_BINDINGS,
): KeyboardShortcutHelpSection[] {
  const seenRows = new Set<string>();
  const rowsBySection = new Map<ShortcutSectionId, KeyboardShortcutHelpRow[]>(
    SHORTCUT_HELP_SECTION_ORDER.map((sectionId) => [sectionId, []]),
  );

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
    const chord = getBindingDisplayChord(binding);
    rows.push({
      id: help.id,
      label: help.label,
      labelKey: SHORTCUT_HELP_LABEL_KEYS[help.id] ?? help.label,
      keys: chord?.[0] ?? [],
      chord,
      ...(help.note ? { note: help.note } : {}),
      ...(SHORTCUT_HELP_NOTE_KEYS[help.id] ? { noteKey: SHORTCUT_HELP_NOTE_KEYS[help.id] } : {}),
    });
  }

  return SHORTCUT_HELP_SECTION_ORDER.flatMap((sectionId) => {
    const rows = rowsBySection.get(sectionId) ?? [];
    if (rows.length === 0) {
      return [];
    }
    const order = SHORTCUT_HELP_ROW_ORDER[sectionId];
    const rank = (row: KeyboardShortcutHelpRow) => {
      const index = order.indexOf(row.id);
      return index === -1 ? order.length : index;
    };
    rows.sort((left, right) => rank(left) - rank(right));
    return [
      {
        id: sectionId,
        title: SHORTCUT_HELP_SECTION_TITLES[sectionId],
        titleKey: SHORTCUT_HELP_SECTION_LABEL_KEYS[sectionId],
        rows,
      },
    ];
  });
}

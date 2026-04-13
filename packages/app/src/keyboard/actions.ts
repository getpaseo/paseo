export type KeyboardFocusScope =
  | "terminal"
  | "message-input"
  | "command-center"
  | "editable"
  | "other";

export type MessageInputKeyboardActionKind =
  | "focus"
  | "send"
  | "queue"
  | "dictation-toggle"
  | "dictation-cancel"
  | "dictation-confirm"
  | "voice-toggle"
  | "voice-mute-toggle";

export type KeyboardActionId =
  | "agent.new"
  | "workspace.tab.new"
  | "workspace.tab.close.current"
  | "workspace.tab.navigate.index"
  | "workspace.tab.navigate.relative"
  | "workspace.pane.split.right"
  | "workspace.pane.split.down"
  | "workspace.pane.focus.left"
  | "workspace.pane.focus.right"
  | "workspace.pane.focus.up"
  | "workspace.pane.focus.down"
  | "workspace.pane.move-tab.left"
  | "workspace.pane.move-tab.right"
  | "workspace.pane.move-tab.up"
  | "workspace.pane.move-tab.down"
  | "workspace.pane.close"
  | "workspace.navigate.index"
  | "workspace.navigate.relative"
  | "sidebar.toggle.left"
  | "sidebar.toggle.right"
  | "sidebar.toggle.both"
  | "settings.toggle"
  | "command-center.toggle"
  | "shortcuts.dialog.toggle"
  | "workspace.terminal.new"
  | "worktree.new"
  | "worktree.archive"
  | "view.toggle.focus"
  | "theme.cycle"
  | "message-input.action";

export type KeyboardShortcutPayload =
  | { index: number }
  | { delta: 1 | -1 }
  | { kind: MessageInputKeyboardActionKind }
  | null;

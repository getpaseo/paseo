import {
  resolveShortcutKeysForAction,
  type ShortcutOverrides,
} from "@/keyboard/keyboard-shortcuts";
import type { WorkspaceCommandCenterShortcuts } from "./workspace-contributions";

interface ResolveWorkspaceCommandCenterShortcutsInput {
  overrides: ShortcutOverrides;
  platform: { isMac: boolean; isDesktop: boolean };
}

export function resolveWorkspaceCommandCenterShortcuts({
  overrides,
  platform,
}: ResolveWorkspaceCommandCenterShortcutsInput): WorkspaceCommandCenterShortcuts {
  return {
    newAgent:
      resolveShortcutKeysForAction("workspace-tab-target-agent", overrides, platform) ?? undefined,
    newTerminal:
      resolveShortcutKeysForAction("workspace-terminal-new", overrides, platform) ?? undefined,
    splitRight:
      resolveShortcutKeysForAction("workspace-pane-split-right", overrides, platform) ?? undefined,
    splitDown:
      resolveShortcutKeysForAction("workspace-pane-split-down", overrides, platform) ?? undefined,
    archiveWorkspace:
      resolveShortcutKeysForAction("archive-workspace", overrides, platform) ?? undefined,
    previousTab:
      resolveShortcutKeysForAction("workspace-tab-prev", overrides, platform) ?? undefined,
    nextTab: resolveShortcutKeysForAction("workspace-tab-next", overrides, platform) ?? undefined,
    closeCurrentTab:
      resolveShortcutKeysForAction("workspace-tab-close-current", overrides, platform) ?? undefined,
    closePane:
      resolveShortcutKeysForAction("workspace-pane-close", overrides, platform) ?? undefined,
    toggleFocusMode: resolveShortcutKeysForAction("toggle-focus", overrides, platform) ?? undefined,
    toggleExplorerSidebar:
      resolveShortcutKeysForAction("toggle-right-sidebar", overrides, platform) ?? undefined,
    // Workspace management shortcuts
    pinWorkspace: resolveShortcutKeysForAction("pin-workspace", overrides, platform) ?? undefined,
  };
}

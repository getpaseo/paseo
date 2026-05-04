import type { KeyboardShortcutPayload, MessageInputKeyboardActionKind } from "@/keyboard/actions";
import type { KeyboardActionDefinition } from "@/keyboard/keyboard-action-dispatcher";
import {
  buildHostWorkspaceRoute,
  buildSettingsRoute,
  parseHostWorkspaceRouteFromPathname,
} from "@/utils/host-routes";
import {
  getRelativeSidebarShortcutTarget,
  type SidebarShortcutWorkspaceTarget,
} from "@/utils/sidebar-shortcuts";

export interface ShortcutRoutingContext {
  pathname: string;
  isMobile: boolean;
  sidebarShortcutTargets: ReadonlyArray<SidebarShortcutWorkspaceTarget>;
  navigationActiveWorkspace: SidebarShortcutWorkspaceTarget | null;
  lastNavigationWorkspaceRoute: SidebarShortcutWorkspaceTarget | null;
  commandCenterOpen: boolean;
  shortcutsDialogOpen: boolean;
}

export interface ShortcutRoutingInput {
  action: string;
  payload: KeyboardShortcutPayload;
}

export type ShortcutCallbackName =
  | "toggle-agent-list"
  | "toggle-both-sidebars"
  | "toggle-focus-mode"
  | "cycle-theme";

export type ShortcutAction =
  | { kind: "none" }
  | { kind: "dispatch"; action: KeyboardActionDefinition }
  | { kind: "navigate-workspace"; serverId: string; workspaceId: string }
  | { kind: "router-replace"; route: string }
  | { kind: "router-back" }
  | { kind: "router-push"; route: string }
  | { kind: "open-project-picker" }
  | { kind: "callback"; name: ShortcutCallbackName }
  | { kind: "command-center-toggle"; nextOpen: boolean }
  | { kind: "shortcuts-dialog-toggle"; nextOpen: boolean };

const NONE: ShortcutAction = { kind: "none" };

// Action ids whose routing is a no-payload pass-through to the dispatcher.
const PASSTHROUGH_DISPATCH: Record<string, KeyboardActionDefinition> = {
  "agent.interrupt": { id: "agent.interrupt", scope: "global" },
  "workspace.tab.new": { id: "workspace.tab.new", scope: "workspace" },
  "worktree.archive": { id: "worktree.archive", scope: "sidebar" },
  "worktree.new": { id: "worktree.new", scope: "sidebar" },
  "workspace.terminal.new": { id: "workspace.terminal.new", scope: "workspace" },
  "workspace.tab.close.current": { id: "workspace.tab.close-current", scope: "workspace" },
  "sidebar.toggle.right": { id: "sidebar.toggle.right", scope: "sidebar" },
  "workspace.pane.split.right": { id: "workspace.pane.split.right", scope: "workspace" },
  "workspace.pane.split.down": { id: "workspace.pane.split.down", scope: "workspace" },
  "workspace.pane.focus.left": { id: "workspace.pane.focus.left", scope: "workspace" },
  "workspace.pane.focus.right": { id: "workspace.pane.focus.right", scope: "workspace" },
  "workspace.pane.focus.up": { id: "workspace.pane.focus.up", scope: "workspace" },
  "workspace.pane.focus.down": { id: "workspace.pane.focus.down", scope: "workspace" },
  "workspace.pane.move-tab.left": { id: "workspace.pane.move-tab.left", scope: "workspace" },
  "workspace.pane.move-tab.right": { id: "workspace.pane.move-tab.right", scope: "workspace" },
  "workspace.pane.move-tab.up": { id: "workspace.pane.move-tab.up", scope: "workspace" },
  "workspace.pane.move-tab.down": { id: "workspace.pane.move-tab.down", scope: "workspace" },
  "workspace.pane.close": { id: "workspace.pane.close", scope: "workspace" },
};

const SIMPLE_CALLBACKS: Record<string, ShortcutCallbackName> = {
  "sidebar.toggle.left": "toggle-agent-list",
  "sidebar.toggle.both": "toggle-both-sidebars",
  "view.toggle.focus": "toggle-focus-mode",
  "theme.cycle": "cycle-theme",
};

const MESSAGE_INPUT_DISPATCH: Record<
  MessageInputKeyboardActionKind,
  KeyboardActionDefinition | null
> = {
  focus: { id: "message-input.focus", scope: "message-input" },
  send: { id: "message-input.send", scope: "message-input" },
  "dictation-toggle": { id: "message-input.dictation-toggle", scope: "message-input" },
  "dictation-cancel": { id: "message-input.dictation-cancel", scope: "message-input" },
  "dictation-confirm": { id: "message-input.dictation-confirm", scope: "message-input" },
  "voice-toggle": { id: "message-input.voice-toggle", scope: "message-input" },
  "voice-mute-toggle": { id: "message-input.voice-mute-toggle", scope: "message-input" },
  queue: null,
};

function hasPayloadKey<K extends "index" | "delta" | "kind">(
  payload: KeyboardShortcutPayload,
  key: K,
): payload is Extract<KeyboardShortcutPayload, Record<K, unknown>> {
  return !!payload && typeof payload === "object" && key in payload;
}

function dispatch(action: KeyboardActionDefinition): ShortcutAction {
  return { kind: "dispatch", action };
}

function routeWorkspaceTabNavigateIndex(payload: KeyboardShortcutPayload): ShortcutAction {
  if (!hasPayloadKey(payload, "index")) return NONE;
  return dispatch({
    id: "workspace.tab.navigate-index",
    scope: "workspace",
    index: payload.index,
  });
}

function routeWorkspaceTabNavigateRelative(payload: KeyboardShortcutPayload): ShortcutAction {
  if (!hasPayloadKey(payload, "delta")) return NONE;
  return dispatch({
    id: "workspace.tab.navigate-relative",
    scope: "workspace",
    delta: payload.delta,
  });
}

function routeWorkspaceNavigateIndex(
  payload: KeyboardShortcutPayload,
  ctx: ShortcutRoutingContext,
): ShortcutAction {
  if (!hasPayloadKey(payload, "index")) return NONE;
  const target = ctx.sidebarShortcutTargets[payload.index - 1] ?? null;
  if (!target) return NONE;
  return {
    kind: "navigate-workspace",
    serverId: target.serverId,
    workspaceId: target.workspaceId,
  };
}

function routeWorkspaceNavigateRelative(
  payload: KeyboardShortcutPayload,
  ctx: ShortcutRoutingContext,
): ShortcutAction {
  if (!hasPayloadKey(payload, "delta")) return NONE;
  if (ctx.sidebarShortcutTargets.length === 0) return NONE;

  const currentWorkspace =
    ctx.navigationActiveWorkspace ?? parseHostWorkspaceRouteFromPathname(ctx.pathname);
  const target = getRelativeSidebarShortcutTarget({
    targets: ctx.sidebarShortcutTargets,
    currentTarget: currentWorkspace
      ? { serverId: currentWorkspace.serverId, workspaceId: currentWorkspace.workspaceId }
      : null,
    delta: payload.delta,
  });
  if (!target) return NONE;
  return {
    kind: "navigate-workspace",
    serverId: target.serverId,
    workspaceId: target.workspaceId,
  };
}

function routeMessageInputAction(payload: KeyboardShortcutPayload): ShortcutAction {
  if (!hasPayloadKey(payload, "kind")) return NONE;
  const action = MESSAGE_INPUT_DISPATCH[payload.kind];
  if (!action) return NONE;
  return dispatch(action);
}

function routeSettingsToggle(ctx: ShortcutRoutingContext): ShortcutAction {
  if (!ctx.pathname.startsWith("/settings")) {
    return { kind: "router-push", route: buildSettingsRoute() };
  }
  if (!ctx.isMobile && ctx.lastNavigationWorkspaceRoute) {
    return {
      kind: "router-replace",
      route: buildHostWorkspaceRoute(
        ctx.lastNavigationWorkspaceRoute.serverId,
        ctx.lastNavigationWorkspaceRoute.workspaceId,
      ),
    };
  }
  return { kind: "router-back" };
}

export function routeKeyboardShortcut(
  input: ShortcutRoutingInput,
  ctx: ShortcutRoutingContext,
): ShortcutAction {
  const passthrough = PASSTHROUGH_DISPATCH[input.action];
  if (passthrough) {
    return dispatch(passthrough);
  }

  const callback = SIMPLE_CALLBACKS[input.action];
  if (callback) {
    return { kind: "callback", name: callback };
  }

  switch (input.action) {
    case "workspace.tab.navigate.index":
      return routeWorkspaceTabNavigateIndex(input.payload);
    case "workspace.tab.navigate.relative":
      return routeWorkspaceTabNavigateRelative(input.payload);
    case "workspace.navigate.index":
      return routeWorkspaceNavigateIndex(input.payload, ctx);
    case "workspace.navigate.relative":
      return routeWorkspaceNavigateRelative(input.payload, ctx);
    case "message-input.action":
      return routeMessageInputAction(input.payload);
    case "agent.new":
      return { kind: "open-project-picker" };
    case "settings.toggle":
      return routeSettingsToggle(ctx);
    case "command-center.toggle":
      return { kind: "command-center-toggle", nextOpen: !ctx.commandCenterOpen };
    case "shortcuts.dialog.toggle":
      return { kind: "shortcuts-dialog-toggle", nextOpen: !ctx.shortcutsDialogOpen };
    default:
      return NONE;
  }
}

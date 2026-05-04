import { describe, expect, it } from "vitest";
import {
  routeKeyboardShortcut,
  type ShortcutAction,
  type ShortcutRoutingContext,
} from "./route-shortcut";

const SIDEBAR_TARGETS = [
  { serverId: "srv", workspaceId: "ws-1" },
  { serverId: "srv", workspaceId: "ws-2" },
  { serverId: "srv", workspaceId: "ws-3" },
  { serverId: "srv", workspaceId: "ws-4" },
  { serverId: "srv", workspaceId: "ws-5" },
] as const;

function makeCtx(overrides: Partial<ShortcutRoutingContext> = {}): ShortcutRoutingContext {
  return {
    pathname: "/h/srv/workspace/ws-2",
    isMobile: false,
    sidebarShortcutTargets: SIDEBAR_TARGETS,
    navigationActiveWorkspace: null,
    lastNavigationWorkspaceRoute: null,
    commandCenterOpen: false,
    shortcutsDialogOpen: false,
    ...overrides,
  };
}

describe("routeKeyboardShortcut — dispatch passthroughs", () => {
  it.each([
    ["agent.interrupt", { id: "agent.interrupt", scope: "global" }],
    ["workspace.tab.new", { id: "workspace.tab.new", scope: "workspace" }],
    ["worktree.archive", { id: "worktree.archive", scope: "sidebar" }],
    ["worktree.new", { id: "worktree.new", scope: "sidebar" }],
    ["workspace.terminal.new", { id: "workspace.terminal.new", scope: "workspace" }],
    ["workspace.tab.close.current", { id: "workspace.tab.close-current", scope: "workspace" }],
    ["sidebar.toggle.right", { id: "sidebar.toggle.right", scope: "sidebar" }],
    ["workspace.pane.split.right", { id: "workspace.pane.split.right", scope: "workspace" }],
    ["workspace.pane.split.down", { id: "workspace.pane.split.down", scope: "workspace" }],
    ["workspace.pane.focus.left", { id: "workspace.pane.focus.left", scope: "workspace" }],
    ["workspace.pane.focus.right", { id: "workspace.pane.focus.right", scope: "workspace" }],
    ["workspace.pane.focus.up", { id: "workspace.pane.focus.up", scope: "workspace" }],
    ["workspace.pane.focus.down", { id: "workspace.pane.focus.down", scope: "workspace" }],
    ["workspace.pane.move-tab.left", { id: "workspace.pane.move-tab.left", scope: "workspace" }],
    ["workspace.pane.move-tab.right", { id: "workspace.pane.move-tab.right", scope: "workspace" }],
    ["workspace.pane.move-tab.up", { id: "workspace.pane.move-tab.up", scope: "workspace" }],
    ["workspace.pane.move-tab.down", { id: "workspace.pane.move-tab.down", scope: "workspace" }],
    ["workspace.pane.close", { id: "workspace.pane.close", scope: "workspace" }],
  ])("%s → dispatch %j", (action, expected) => {
    expect(routeKeyboardShortcut({ action, payload: null }, makeCtx())).toEqual({
      kind: "dispatch",
      action: expected,
    });
  });
});

describe("routeKeyboardShortcut — workspace.tab.navigate", () => {
  it("forwards index payloads to the workspace.tab.navigate-index dispatch", () => {
    expect(
      routeKeyboardShortcut(
        { action: "workspace.tab.navigate.index", payload: { index: 3 } },
        makeCtx(),
      ),
    ).toEqual<ShortcutAction>({
      kind: "dispatch",
      action: { id: "workspace.tab.navigate-index", scope: "workspace", index: 3 },
    });
  });

  it("returns none when index payload is missing", () => {
    expect(
      routeKeyboardShortcut({ action: "workspace.tab.navigate.index", payload: null }, makeCtx()),
    ).toEqual<ShortcutAction>({ kind: "none" });
  });

  it("forwards delta payloads to the workspace.tab.navigate-relative dispatch", () => {
    expect(
      routeKeyboardShortcut(
        { action: "workspace.tab.navigate.relative", payload: { delta: -1 } },
        makeCtx(),
      ),
    ).toEqual<ShortcutAction>({
      kind: "dispatch",
      action: { id: "workspace.tab.navigate-relative", scope: "workspace", delta: -1 },
    });
  });

  it("returns none when delta payload is missing", () => {
    expect(
      routeKeyboardShortcut(
        { action: "workspace.tab.navigate.relative", payload: null },
        makeCtx(),
      ),
    ).toEqual<ShortcutAction>({ kind: "none" });
  });
});

describe("routeKeyboardShortcut — workspace.navigate.index", () => {
  it("navigates to the sidebar target at index-1", () => {
    expect(
      routeKeyboardShortcut(
        { action: "workspace.navigate.index", payload: { index: 4 } },
        makeCtx(),
      ),
    ).toEqual<ShortcutAction>({
      kind: "navigate-workspace",
      serverId: "srv",
      workspaceId: "ws-4",
    });
  });

  it("returns none when the target index is out of range", () => {
    expect(
      routeKeyboardShortcut(
        { action: "workspace.navigate.index", payload: { index: 99 } },
        makeCtx(),
      ),
    ).toEqual<ShortcutAction>({ kind: "none" });
  });

  it("returns none when the index payload is missing", () => {
    expect(
      routeKeyboardShortcut({ action: "workspace.navigate.index", payload: null }, makeCtx()),
    ).toEqual<ShortcutAction>({ kind: "none" });
  });

  it("returns none when there are no sidebar targets", () => {
    expect(
      routeKeyboardShortcut(
        { action: "workspace.navigate.index", payload: { index: 1 } },
        makeCtx({ sidebarShortcutTargets: [] }),
      ),
    ).toEqual<ShortcutAction>({ kind: "none" });
  });
});

describe("routeKeyboardShortcut — workspace.navigate.relative", () => {
  it("uses the retained navigation workspace selection over a stale pathname", () => {
    expect(
      routeKeyboardShortcut(
        { action: "workspace.navigate.relative", payload: { delta: 1 } },
        makeCtx({
          pathname: "/h/srv/workspace/ws-2",
          navigationActiveWorkspace: { serverId: "srv", workspaceId: "ws-4" },
        }),
      ),
    ).toEqual<ShortcutAction>({
      kind: "navigate-workspace",
      serverId: "srv",
      workspaceId: "ws-5",
    });
  });

  it("falls back to the pathname workspace when no retained selection exists", () => {
    expect(
      routeKeyboardShortcut(
        { action: "workspace.navigate.relative", payload: { delta: -1 } },
        makeCtx({ pathname: "/h/srv/workspace/ws-3", navigationActiveWorkspace: null }),
      ),
    ).toEqual<ShortcutAction>({
      kind: "navigate-workspace",
      serverId: "srv",
      workspaceId: "ws-2",
    });
  });

  it("wraps from the last target forward to the first", () => {
    expect(
      routeKeyboardShortcut(
        { action: "workspace.navigate.relative", payload: { delta: 1 } },
        makeCtx({ navigationActiveWorkspace: { serverId: "srv", workspaceId: "ws-5" } }),
      ),
    ).toEqual<ShortcutAction>({
      kind: "navigate-workspace",
      serverId: "srv",
      workspaceId: "ws-1",
    });
  });

  it("returns none when there are no sidebar targets", () => {
    expect(
      routeKeyboardShortcut(
        { action: "workspace.navigate.relative", payload: { delta: 1 } },
        makeCtx({ sidebarShortcutTargets: [] }),
      ),
    ).toEqual<ShortcutAction>({ kind: "none" });
  });

  it("returns none when the delta payload is missing", () => {
    expect(
      routeKeyboardShortcut({ action: "workspace.navigate.relative", payload: null }, makeCtx()),
    ).toEqual<ShortcutAction>({ kind: "none" });
  });

  it("falls back to the first target when the current workspace is not in the sidebar", () => {
    expect(
      routeKeyboardShortcut(
        { action: "workspace.navigate.relative", payload: { delta: 1 } },
        makeCtx({
          pathname: "/settings/general",
          navigationActiveWorkspace: { serverId: "other", workspaceId: "ws-x" },
        }),
      ),
    ).toEqual<ShortcutAction>({
      kind: "navigate-workspace",
      serverId: "srv",
      workspaceId: "ws-1",
    });
  });
});

describe("routeKeyboardShortcut — message-input.action", () => {
  it.each([
    ["focus", "message-input.focus"],
    ["send", "message-input.send"],
    ["dictation-toggle", "message-input.dictation-toggle"],
    ["dictation-cancel", "message-input.dictation-cancel"],
    ["dictation-confirm", "message-input.dictation-confirm"],
    ["voice-toggle", "message-input.voice-toggle"],
    ["voice-mute-toggle", "message-input.voice-mute-toggle"],
  ] as const)("kind=%s → dispatch %s", (kind, id) => {
    expect(
      routeKeyboardShortcut({ action: "message-input.action", payload: { kind } }, makeCtx()),
    ).toEqual<ShortcutAction>({
      kind: "dispatch",
      action: { id, scope: "message-input" },
    });
  });

  it("returns none for unsupported message-input kinds (queue)", () => {
    expect(
      routeKeyboardShortcut(
        { action: "message-input.action", payload: { kind: "queue" } },
        makeCtx(),
      ),
    ).toEqual<ShortcutAction>({ kind: "none" });
  });

  it("returns none when kind is missing", () => {
    expect(
      routeKeyboardShortcut({ action: "message-input.action", payload: null }, makeCtx()),
    ).toEqual<ShortcutAction>({ kind: "none" });
  });
});

describe("routeKeyboardShortcut — settings.toggle", () => {
  it("pushes to the settings root when not currently in settings", () => {
    expect(
      routeKeyboardShortcut(
        { action: "settings.toggle", payload: null },
        makeCtx({ pathname: "/h/srv/workspace/ws-2" }),
      ),
    ).toEqual<ShortcutAction>({ kind: "router-push", route: "/settings" });
  });

  it("replaces to the retained workspace route when leaving settings on desktop", () => {
    expect(
      routeKeyboardShortcut(
        { action: "settings.toggle", payload: null },
        makeCtx({
          pathname: "/settings/general",
          isMobile: false,
          lastNavigationWorkspaceRoute: { serverId: "srv", workspaceId: "ws-2" },
        }),
      ),
    ).toEqual<ShortcutAction>({
      kind: "router-replace",
      route: "/h/srv/workspace/ws-2",
    });
  });

  it("falls back to router.back() when no retained workspace exists", () => {
    expect(
      routeKeyboardShortcut(
        { action: "settings.toggle", payload: null },
        makeCtx({ pathname: "/settings/general", lastNavigationWorkspaceRoute: null }),
      ),
    ).toEqual<ShortcutAction>({ kind: "router-back" });
  });

  it("falls back to router.back() on mobile even if a retained workspace exists", () => {
    expect(
      routeKeyboardShortcut(
        { action: "settings.toggle", payload: null },
        makeCtx({
          pathname: "/settings/general",
          isMobile: true,
          lastNavigationWorkspaceRoute: { serverId: "srv", workspaceId: "ws-2" },
        }),
      ),
    ).toEqual<ShortcutAction>({ kind: "router-back" });
  });
});

describe("routeKeyboardShortcut — callbacks and pickers", () => {
  it.each([
    ["sidebar.toggle.left", "toggle-agent-list"],
    ["sidebar.toggle.both", "toggle-both-sidebars"],
    ["view.toggle.focus", "toggle-focus-mode"],
    ["theme.cycle", "cycle-theme"],
  ] as const)("%s → callback %s", (action, name) => {
    expect(routeKeyboardShortcut({ action, payload: null }, makeCtx())).toEqual<ShortcutAction>({
      kind: "callback",
      name,
    });
  });

  it("agent.new → open-project-picker", () => {
    expect(
      routeKeyboardShortcut({ action: "agent.new", payload: null }, makeCtx()),
    ).toEqual<ShortcutAction>({ kind: "open-project-picker" });
  });
});

describe("routeKeyboardShortcut — toggle dialogs", () => {
  it("opens the command center when closed", () => {
    expect(
      routeKeyboardShortcut(
        { action: "command-center.toggle", payload: null },
        makeCtx({ commandCenterOpen: false }),
      ),
    ).toEqual<ShortcutAction>({ kind: "command-center-toggle", nextOpen: true });
  });

  it("closes the command center when open", () => {
    expect(
      routeKeyboardShortcut(
        { action: "command-center.toggle", payload: null },
        makeCtx({ commandCenterOpen: true }),
      ),
    ).toEqual<ShortcutAction>({ kind: "command-center-toggle", nextOpen: false });
  });

  it("toggles the shortcuts dialog", () => {
    expect(
      routeKeyboardShortcut(
        { action: "shortcuts.dialog.toggle", payload: null },
        makeCtx({ shortcutsDialogOpen: false }),
      ),
    ).toEqual<ShortcutAction>({ kind: "shortcuts-dialog-toggle", nextOpen: true });

    expect(
      routeKeyboardShortcut(
        { action: "shortcuts.dialog.toggle", payload: null },
        makeCtx({ shortcutsDialogOpen: true }),
      ),
    ).toEqual<ShortcutAction>({ kind: "shortcuts-dialog-toggle", nextOpen: false });
  });
});

describe("routeKeyboardShortcut — unknown actions", () => {
  it("returns none for unknown action ids", () => {
    expect(
      routeKeyboardShortcut({ action: "totally.made.up", payload: null }, makeCtx()),
    ).toEqual<ShortcutAction>({ kind: "none" });
  });
});

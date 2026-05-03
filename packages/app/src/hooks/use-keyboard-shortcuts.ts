import { useEffect, useMemo, useRef } from "react";
import { usePathname, useRouter } from "expo-router";
import { getIsElectronRuntime } from "@/constants/layout";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { setCommandCenterFocusRestoreElement } from "@/utils/command-center-focus-restore";
import {
  buildHostWorkspaceRoute,
  buildSettingsRoute,
  parseHostWorkspaceRouteFromPathname,
} from "@/utils/host-routes";
import { navigateToWorkspace } from "@/hooks/use-workspace-navigation";
import {
  type MessageInputKeyboardActionKind,
  type KeyboardShortcutPayload,
} from "@/keyboard/actions";
import { keyboardActionDispatcher } from "@/keyboard/keyboard-action-dispatcher";
import {
  type ChordState,
  resolveKeyboardShortcut,
  buildEffectiveBindings,
} from "@/keyboard/keyboard-shortcuts";
import { resolveKeyboardFocusScope } from "@/keyboard/focus-scope";
import { getShortcutOs } from "@/utils/shortcut-platform";
import { useOpenProjectPicker } from "@/hooks/use-open-project-picker";
import { useKeyboardShortcutOverrides } from "@/hooks/use-keyboard-shortcut-overrides";
import { isNative } from "@/constants/platform";
import { getDesktopHost, isElectronRuntime } from "@/desktop/host";
import { isImeComposingKeyboardEvent } from "@/utils/keyboard-ime";
import { getRelativeSidebarShortcutTarget } from "@/utils/sidebar-shortcuts";
import { useActiveServerId } from "@/hooks/use-active-server-id";
import {
  getLastNavigationWorkspaceRouteSelection,
  getNavigationActiveWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { handlePaneFindKeyboardAction } from "@/panels/pane-find-registry";

type KeyboardShortcutResult = ReturnType<typeof resolveKeyboardShortcut>;

function applyPendingChordEventHandling(event: KeyboardEvent, result: KeyboardShortcutResult) {
  if (result.preventDefault && !result.match) {
    event.preventDefault();
    event.stopPropagation();
  }
}

function applyHandledShortcutEventHandling(event: KeyboardEvent, result: KeyboardShortcutResult) {
  if (result.preventDefault || result.match?.preventDefault) {
    event.preventDefault();
  }
  if (result.preventDefault || result.match?.stopPropagation) {
    event.stopPropagation();
  }
}

function hasPayloadKey<K extends string>(
  payload: KeyboardShortcutPayload,
  key: K,
): payload is KeyboardShortcutPayload & Record<K, never> {
  return !!payload && typeof payload === "object" && key in payload;
}

export function useKeyboardShortcuts({
  enabled,
  isMobile,
  toggleAgentList,
  toggleBothSidebars,
  toggleFocusMode,
  cycleTheme,
}: {
  enabled: boolean;
  isMobile: boolean;
  toggleAgentList: () => void;
  toggleBothSidebars?: () => void;
  toggleFocusMode?: () => void;
  cycleTheme?: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const resetModifiers = useKeyboardShortcutsStore((s) => s.resetModifiers);
  const { overrides } = useKeyboardShortcutOverrides();
  const bindings = useMemo(() => buildEffectiveBindings(overrides), [overrides]);
  const chordStateRef = useRef<ChordState>({
    candidateIndices: [],
    step: 0,
    timeoutId: null,
  });
  const activeServerId = useActiveServerId();
  const openProjectPickerAction = useOpenProjectPicker(activeServerId);

  useEffect(() => {
    if (!enabled) return;
    if (isNative) return;
    if (isMobile) return;

    const isDesktopApp = getIsElectronRuntime();
    const isMac = getShortcutOs() === "mac";

    const shouldHandle = () => {
      if (typeof document === "undefined") return false;
      if (document.visibilityState !== "visible") return false;
      return true;
    };

    const navigateToWorkspaceShortcut = (index: number): boolean => {
      const state = useKeyboardShortcutsStore.getState();
      const target = state.sidebarShortcutWorkspaceTargets[index - 1] ?? null;
      if (!target) {
        return false;
      }

      navigateToWorkspace(target.serverId, target.workspaceId, { currentPathname: pathname });
      return true;
    };
    const navigateRelativeWorkspace = (delta: 1 | -1): boolean => {
      const state = useKeyboardShortcutsStore.getState();
      const targets = state.sidebarShortcutWorkspaceTargets;
      if (targets.length === 0) {
        return false;
      }

      const workspaceRoute =
        getNavigationActiveWorkspaceSelection() ?? parseHostWorkspaceRouteFromPathname(pathname);
      const target = getRelativeSidebarShortcutTarget({
        targets,
        currentTarget: workspaceRoute
          ? {
              serverId: workspaceRoute.serverId,
              workspaceId: workspaceRoute.workspaceId,
            }
          : null,
        delta,
      });
      if (!target) {
        return false;
      }
      navigateToWorkspace(target.serverId, target.workspaceId, { currentPathname: pathname });
      return true;
    };

    const openProjectPicker = (): boolean => {
      void openProjectPickerAction();
      return true;
    };

    const dispatchMessageInputAction = (kind: MessageInputKeyboardActionKind): boolean => {
      switch (kind) {
        case "focus":
          return keyboardActionDispatcher.dispatch({
            id: "message-input.focus",
            scope: "message-input",
          });
        case "send":
          return keyboardActionDispatcher.dispatch({
            id: "message-input.send",
            scope: "message-input",
          });
        case "dictation-toggle":
          return keyboardActionDispatcher.dispatch({
            id: "message-input.dictation-toggle",
            scope: "message-input",
          });
        case "dictation-cancel":
          return keyboardActionDispatcher.dispatch({
            id: "message-input.dictation-cancel",
            scope: "message-input",
          });
        case "dictation-confirm":
          return keyboardActionDispatcher.dispatch({
            id: "message-input.dictation-confirm",
            scope: "message-input",
          });
        case "voice-toggle":
          return keyboardActionDispatcher.dispatch({
            id: "message-input.voice-toggle",
            scope: "message-input",
          });
        case "voice-mute-toggle":
          return keyboardActionDispatcher.dispatch({
            id: "message-input.voice-mute-toggle",
            scope: "message-input",
          });
        default:
          return false;
      }
    };
    const handleDispatchOnlyAction = (action: string): boolean | null => {
      switch (action) {
        case "agent.interrupt":
          return keyboardActionDispatcher.dispatch({ id: "agent.interrupt", scope: "global" });
        case "workspace.tab.new":
          return keyboardActionDispatcher.dispatch({ id: "workspace.tab.new", scope: "workspace" });
        case "worktree.archive":
          return keyboardActionDispatcher.dispatch({ id: "worktree.archive", scope: "sidebar" });
        case "worktree.new":
          return keyboardActionDispatcher.dispatch({ id: "worktree.new", scope: "sidebar" });
        case "workspace.terminal.new":
          return keyboardActionDispatcher.dispatch({
            id: "workspace.terminal.new",
            scope: "workspace",
          });
        case "workspace.tab.close.current":
          return keyboardActionDispatcher.dispatch({
            id: "workspace.tab.close-current",
            scope: "workspace",
          });
        case "workspace.find.open":
          return handlePaneFindKeyboardAction({
            id: "workspace.find.open",
            scope: "workspace",
          });
        case "sidebar.toggle.right":
          return keyboardActionDispatcher.dispatch({
            id: "sidebar.toggle.right",
            scope: "sidebar",
          });
        case "workspace.pane.split.right":
        case "workspace.pane.split.down":
        case "workspace.pane.focus.left":
        case "workspace.pane.focus.right":
        case "workspace.pane.focus.up":
        case "workspace.pane.focus.down":
        case "workspace.pane.move-tab.left":
        case "workspace.pane.move-tab.right":
        case "workspace.pane.move-tab.up":
        case "workspace.pane.move-tab.down":
        case "workspace.pane.close":
          return keyboardActionDispatcher.dispatch({ id: action, scope: "workspace" });
        default:
          return null;
      }
    };

    const handlePayloadAction = (
      action: string,
      payload: KeyboardShortcutPayload,
    ): boolean | null => {
      switch (action) {
        case "workspace.tab.navigate.index":
          if (!hasPayloadKey(payload, "index")) return false;
          return keyboardActionDispatcher.dispatch({
            id: "workspace.tab.navigate-index",
            scope: "workspace",
            index: payload.index,
          });
        case "workspace.tab.navigate.relative":
          if (!hasPayloadKey(payload, "delta")) return false;
          return keyboardActionDispatcher.dispatch({
            id: "workspace.tab.navigate-relative",
            scope: "workspace",
            delta: payload.delta,
          });
        case "workspace.navigate.index":
          if (!hasPayloadKey(payload, "index")) return false;
          return navigateToWorkspaceShortcut(payload.index);
        case "workspace.navigate.relative":
          if (!hasPayloadKey(payload, "delta")) return false;
          return navigateRelativeWorkspace(payload.delta);
        case "message-input.action":
          if (!hasPayloadKey(payload, "kind")) return false;
          return dispatchMessageInputAction(payload.kind);
        default:
          return null;
      }
    };

    const handleSettingsToggle = (): boolean => {
      if (pathname.startsWith("/settings")) {
        if (!isMobile) {
          const lastWorkspaceRoute = getLastNavigationWorkspaceRouteSelection();
          if (lastWorkspaceRoute) {
            router.replace(
              buildHostWorkspaceRoute(lastWorkspaceRoute.serverId, lastWorkspaceRoute.workspaceId),
            );
            return true;
          }
        }
        router.back();
        return true;
      }
      router.push(buildSettingsRoute());
      return true;
    };

    const handleCommandCenterToggle = (event: KeyboardEvent): boolean => {
      const store = useKeyboardShortcutsStore.getState();
      if (!store.commandCenterOpen) {
        const target = event.target instanceof Element ? (event.target as Element) : null;
        const targetEl =
          target?.closest?.("textarea, input, [contenteditable='true']") ??
          (target instanceof HTMLElement ? target : null);
        const active = document.activeElement;
        const activeEl = active instanceof HTMLElement ? active : null;
        setCommandCenterFocusRestoreElement((targetEl as HTMLElement | null) ?? activeEl ?? null);
      }
      store.setCommandCenterOpen(!store.commandCenterOpen);
      return true;
    };

    const handleAction = (input: {
      action: string;
      payload: KeyboardShortcutPayload;
      event: KeyboardEvent;
    }): boolean => {
      const dispatchOnlyResult = handleDispatchOnlyAction(input.action);
      if (dispatchOnlyResult !== null) {
        return dispatchOnlyResult;
      }
      const payloadResult = handlePayloadAction(input.action, input.payload);
      if (payloadResult !== null) {
        return payloadResult;
      }
      switch (input.action) {
        case "agent.new":
          return openProjectPicker();
        case "sidebar.toggle.left":
          toggleAgentList();
          return true;
        case "settings.toggle":
          return handleSettingsToggle();
        case "sidebar.toggle.both":
          if (toggleBothSidebars) {
            toggleBothSidebars();
          }
          return true;
        case "view.toggle.focus":
          if (toggleFocusMode) {
            toggleFocusMode();
          }
          return true;
        case "theme.cycle":
          if (cycleTheme) {
            cycleTheme();
          }
          return true;
        case "command-center.toggle":
          return handleCommandCenterToggle(input.event);
        case "shortcuts.dialog.toggle": {
          const store = useKeyboardShortcutsStore.getState();
          store.setShortcutsDialogOpen(!store.shortcutsDialogOpen);
          return true;
        }
        default:
          return false;
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!shouldHandle()) {
        return;
      }

      // During IME composition, Enter confirms the candidate selection and must
      // not route through global shortcuts like message send.
      if (isImeComposingKeyboardEvent(event)) {
        return;
      }

      const store = useKeyboardShortcutsStore.getState();
      if (store.capturingShortcut) {
        return;
      }

      const key = event.key ?? "";
      if (key === "Alt" && !event.shiftKey) {
        useKeyboardShortcutsStore.getState().setAltDown(true);
      }
      if (isDesktopApp && (key === "Meta" || key === "Control") && !event.shiftKey) {
        useKeyboardShortcutsStore.getState().setCmdOrCtrlDown(true);
      }
      if (key === "Shift") {
        const state = useKeyboardShortcutsStore.getState();
        if (state.altDown || state.cmdOrCtrlDown) {
          state.resetModifiers();
        }
      }

      const focusScope = resolveKeyboardFocusScope({
        target: event.target,
        commandCenterOpen: store.commandCenterOpen,
      });
      const result = resolveKeyboardShortcut({
        event,
        context: {
          isMac,
          isDesktop: isDesktopApp,
          focusScope,
          commandCenterOpen: store.commandCenterOpen,
        },
        chordState: chordStateRef.current,
        onChordReset: () => {
          chordStateRef.current = {
            candidateIndices: [],
            step: 0,
            timeoutId: null,
          };
        },
        bindings,
      });

      chordStateRef.current = result.nextChordState;

      applyPendingChordEventHandling(event, result);

      if (!result.match) {
        return;
      }

      const handled = handleAction({
        action: result.match.action,
        payload: result.match.payload,
        event,
      });
      if (!handled) {
        return;
      }

      applyHandledShortcutEventHandling(event, result);
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      const key = event.key ?? "";
      if (key === "Alt") {
        useKeyboardShortcutsStore.getState().setAltDown(false);
      }
      if (isDesktopApp && (key === "Meta" || key === "Control")) {
        useKeyboardShortcutsStore.getState().setCmdOrCtrlDown(false);
      }
    };

    const handleBlurOrHide = () => {
      resetModifiers();
    };

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("blur", handleBlurOrHide);
    document.addEventListener("visibilitychange", handleBlurOrHide);

    const forwardedKeySubscription = isElectronRuntime()
      ? getDesktopHost()?.events?.on?.("browser-forwarded-key", (payload) => {
          if (!payload || typeof payload !== "object") return;
          const p = payload as Record<string, unknown>;
          if (typeof p.key !== "string") return;
          window.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: p.key,
              code: typeof p.code === "string" ? p.code : "",
              metaKey: p.meta === true,
              ctrlKey: p.control === true,
              shiftKey: p.shift === true,
              altKey: p.alt === true,
              bubbles: true,
            }),
          );
        })
      : null;

    return () => {
      if (chordStateRef.current.timeoutId !== null) {
        clearTimeout(chordStateRef.current.timeoutId);
        chordStateRef.current = {
          candidateIndices: [],
          step: 0,
          timeoutId: null,
        };
      }
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("blur", handleBlurOrHide);
      document.removeEventListener("visibilitychange", handleBlurOrHide);
      if (typeof forwardedKeySubscription === "function") {
        forwardedKeySubscription();
      } else {
        void forwardedKeySubscription?.then((dispose) => dispose());
      }
    };
  }, [
    bindings,
    cycleTheme,
    enabled,
    isMobile,
    openProjectPickerAction,
    pathname,
    resetModifiers,
    router,
    toggleAgentList,
    toggleBothSidebars,
    toggleFocusMode,
  ]);
}

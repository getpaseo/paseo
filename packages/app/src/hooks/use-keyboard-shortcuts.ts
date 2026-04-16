import { useEffect, useMemo, useRef } from "react";
import { usePathname, useRouter } from "expo-router";
import { getIsElectronRuntime } from "@/constants/layout";
import { useHosts } from "@/runtime/host-runtime";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { setCommandCenterFocusRestoreElement } from "@/utils/command-center-focus-restore";
import {
  buildHostSettingsRoute,
  parseHostAgentRouteFromPathname,
  parseServerIdFromPathname,
  parseHostWorkspaceRouteFromPathname,
} from "@/utils/host-routes";
import { navigateToWorkspace } from "@/hooks/use-workspace-navigation";
import {
  type MessageInputKeyboardActionKind,
  type KeyboardShortcutPayload,
} from "@/keyboard/actions";
import { canToggleFileExplorerShortcut } from "@/keyboard/keyboard-shortcut-routing";
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
import { isImeComposingKeyboardEvent } from "@/utils/keyboard-ime";

export function useKeyboardShortcuts({
  enabled,
  isMobile,
  toggleAgentList,
  selectedAgentId,
  toggleFileExplorer,
  toggleBothSidebars,
  toggleFocusMode,
  cycleTheme,
}: {
  enabled: boolean;
  isMobile: boolean;
  toggleAgentList: () => void;
  selectedAgentId?: string;
  toggleFileExplorer?: () => void;
  toggleBothSidebars?: () => void;
  toggleFocusMode?: () => void;
  cycleTheme?: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const hosts = useHosts();
  const resetModifiers = useKeyboardShortcutsStore((s) => s.resetModifiers);
  const { overrides } = useKeyboardShortcutOverrides();
  const bindings = useMemo(() => buildEffectiveBindings(overrides), [overrides]);
  const chordStateRef = useRef<ChordState>({
    candidateIndices: [],
    step: 0,
    timeoutId: null,
  });
  const activeServerIdFromPath = parseServerIdFromPathname(pathname);
  const activeServerId =
    hosts.find((host) => host.serverId === activeServerIdFromPath)?.serverId ??
    hosts[0]?.serverId ??
    null;
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

      navigateToWorkspace(target.serverId, target.workspaceId);
      return true;
    };
    const navigateRelativeWorkspace = (delta: 1 | -1): boolean => {
      const state = useKeyboardShortcutsStore.getState();
      const targets = state.visibleWorkspaceTargets;
      if (targets.length === 0) {
        return false;
      }

      const workspaceRoute = parseHostWorkspaceRouteFromPathname(pathname);
      if (!workspaceRoute) {
        const fallback = targets[delta > 0 ? 0 : targets.length - 1] ?? null;
        if (!fallback) {
          return false;
        }
        navigateToWorkspace(fallback.serverId, fallback.workspaceId);
        return true;
      }

      const currentIndex = targets.findIndex(
        (target) =>
          target.serverId === workspaceRoute.serverId &&
          target.workspaceId === workspaceRoute.workspaceId,
      );
      const fromIndex = currentIndex >= 0 ? currentIndex : delta > 0 ? -1 : 0;
      const nextIndex = (fromIndex + delta + targets.length) % targets.length;
      const target = targets[nextIndex] ?? null;
      if (!target) {
        return false;
      }
      navigateToWorkspace(target.serverId, target.workspaceId);
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
    const handleAction = (input: {
      action: string;
      payload: KeyboardShortcutPayload;
      event: KeyboardEvent;
    }): boolean => {
      switch (input.action) {
        case "agent.new":
          return openProjectPicker();
        case "workspace.tab.new":
          return keyboardActionDispatcher.dispatch({
            id: "workspace.tab.new",
            scope: "workspace",
          });
        case "worktree.archive":
          return keyboardActionDispatcher.dispatch({
            id: "worktree.archive",
            scope: "sidebar",
          });
        case "worktree.new":
          return keyboardActionDispatcher.dispatch({
            id: "worktree.new",
            scope: "sidebar",
          });
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
        case "workspace.tab.navigate.index":
          if (!input.payload || typeof input.payload !== "object" || !("index" in input.payload)) {
            return false;
          }
          return keyboardActionDispatcher.dispatch({
            id: "workspace.tab.navigate-index",
            scope: "workspace",
            index: input.payload.index,
          });
        case "workspace.tab.navigate.relative":
          if (!input.payload || typeof input.payload !== "object" || !("delta" in input.payload)) {
            return false;
          }
          return keyboardActionDispatcher.dispatch({
            id: "workspace.tab.navigate-relative",
            scope: "workspace",
            delta: input.payload.delta,
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
          return keyboardActionDispatcher.dispatch({
            id: input.action,
            scope: "workspace",
          });
        case "workspace.navigate.index":
          if (!input.payload || typeof input.payload !== "object" || !("index" in input.payload)) {
            return false;
          }
          return navigateToWorkspaceShortcut(input.payload.index);
        case "workspace.navigate.relative":
          if (!input.payload || typeof input.payload !== "object" || !("delta" in input.payload)) {
            return false;
          }
          return navigateRelativeWorkspace(input.payload.delta);
        case "sidebar.toggle.left":
          toggleAgentList();
          return true;
        case "settings.toggle":
          if (pathname.endsWith("/settings")) {
            router.back();
            return true;
          }
          if (!activeServerId) {
            return false;
          }
          router.push(buildHostSettingsRoute(activeServerId));
          return true;
        case "sidebar.toggle.both":
          if (toggleBothSidebars) {
            toggleBothSidebars();
          }
          return true;
        case "sidebar.toggle.right":
          if (!toggleFileExplorer) {
            return false;
          }
          if (
            !canToggleFileExplorerShortcut({
              selectedAgentId,
              pathname,
              toggleFileExplorer,
            })
          ) {
            return false;
          }
          toggleFileExplorer();
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
        case "command-center.toggle": {
          const store = useKeyboardShortcutsStore.getState();
          if (!store.commandCenterOpen) {
            const target =
              input.event.target instanceof Element ? (input.event.target as Element) : null;
            const targetEl =
              target?.closest?.("textarea, input, [contenteditable='true']") ??
              (target instanceof HTMLElement ? target : null);
            const active = document.activeElement;
            const activeEl = active instanceof HTMLElement ? active : null;
            setCommandCenterFocusRestoreElement(
              (targetEl as HTMLElement | null) ?? activeEl ?? null,
            );
          }
          store.setCommandCenterOpen(!store.commandCenterOpen);
          return true;
        }
        case "shortcuts.dialog.toggle": {
          const store = useKeyboardShortcutsStore.getState();
          store.setShortcutsDialogOpen(!store.shortcutsDialogOpen);
          return true;
        }
        case "message-input.action":
          if (!input.payload || typeof input.payload !== "object" || !("kind" in input.payload)) {
            return false;
          }
          return dispatchMessageInputAction(input.payload.kind);
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
          hasSelectedAgent: canToggleFileExplorerShortcut({
            selectedAgentId,
            pathname,
            toggleFileExplorer,
          }),
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

      if (result.preventDefault) {
        event.preventDefault();
        event.stopPropagation();
      }

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

      if (result.match.preventDefault) {
        event.preventDefault();
      }
      if (result.match.stopPropagation) {
        event.stopPropagation();
      }
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
    };
  }, [
    bindings,
    cycleTheme,
    enabled,
    isMobile,
    openProjectPickerAction,
    pathname,
    resetModifiers,
    selectedAgentId,
    toggleAgentList,
    toggleFileExplorer,
    toggleFocusMode,
  ]);
}

import { useEffect, useMemo, useRef } from "react";
import { usePathname, useRouter } from "expo-router";
import { getIsElectronRuntime } from "@/constants/layout";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { setCommandCenterFocusRestoreElement } from "@/utils/command-center-focus-restore";
import { navigateToWorkspace } from "@/hooks/use-workspace-navigation";
import { keyboardActionDispatcher } from "@/keyboard/keyboard-action-dispatcher";
import {
  type ChordState,
  resolveKeyboardShortcut,
  buildEffectiveBindings,
} from "@/keyboard/keyboard-shortcuts";
import { resolveKeyboardFocusScope } from "@/keyboard/focus-scope";
import {
  routeKeyboardShortcut,
  type ShortcutAction,
  type ShortcutCallbackName,
} from "@/keyboard/route-shortcut";
import { getShortcutOs } from "@/utils/shortcut-platform";
import { useOpenProjectPicker } from "@/hooks/use-open-project-picker";
import { useKeyboardShortcutOverrides } from "@/hooks/use-keyboard-shortcut-overrides";
import { isNative } from "@/constants/platform";
import { getDesktopHost, isElectronRuntime } from "@/desktop/host";
import { isImeComposingKeyboardEvent } from "@/utils/keyboard-ime";
import { useActiveServerId } from "@/hooks/use-active-server-id";
import {
  getLastNavigationWorkspaceRouteSelection,
  getNavigationActiveWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";

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

    const captureCommandCenterFocusRestore = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const targetEl =
        target?.closest?.("textarea, input, [contenteditable='true']") ??
        (target instanceof HTMLElement ? target : null);
      const active = document.activeElement;
      const activeEl = active instanceof HTMLElement ? active : null;
      setCommandCenterFocusRestoreElement((targetEl as HTMLElement | null) ?? activeEl ?? null);
    };

    const callbacksByName: Record<ShortcutCallbackName, (() => void) | undefined> = {
      "toggle-agent-list": toggleAgentList,
      "toggle-both-sidebars": toggleBothSidebars,
      "toggle-focus-mode": toggleFocusMode,
      "cycle-theme": cycleTheme,
    };

    const performShortcutAction = (action: ShortcutAction, event: KeyboardEvent): boolean => {
      switch (action.kind) {
        case "none":
          return false;
        case "dispatch":
          return keyboardActionDispatcher.dispatch(action.action);
        case "navigate-workspace":
          navigateToWorkspace(action.serverId, action.workspaceId, { currentPathname: pathname });
          return true;
        case "router-replace":
          router.replace(action.route as Parameters<typeof router.replace>[0]);
          return true;
        case "router-back":
          router.back();
          return true;
        case "router-push":
          router.push(action.route as Parameters<typeof router.push>[0]);
          return true;
        case "open-project-picker":
          void openProjectPickerAction();
          return true;
        case "callback":
          callbacksByName[action.name]?.();
          return true;
        case "command-center-toggle": {
          if (action.nextOpen) {
            captureCommandCenterFocusRestore(event);
          }
          useKeyboardShortcutsStore.getState().setCommandCenterOpen(action.nextOpen);
          return true;
        }
        case "shortcuts-dialog-toggle":
          useKeyboardShortcutsStore.getState().setShortcutsDialogOpen(action.nextOpen);
          return true;
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

      if (result.preventDefault) {
        event.preventDefault();
        event.stopPropagation();
      }

      if (!result.match) {
        return;
      }

      const shortcutAction = routeKeyboardShortcut(
        { action: result.match.action, payload: result.match.payload },
        {
          pathname,
          isMobile,
          sidebarShortcutTargets: store.sidebarShortcutWorkspaceTargets,
          navigationActiveWorkspace: getNavigationActiveWorkspaceSelection(),
          lastNavigationWorkspaceRoute: getLastNavigationWorkspaceRouteSelection(),
          commandCenterOpen: store.commandCenterOpen,
          shortcutsDialogOpen: store.shortcutsDialogOpen,
        },
      );

      const handled = performShortcutAction(shortcutAction, event);
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

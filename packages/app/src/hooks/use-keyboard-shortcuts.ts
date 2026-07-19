import { useCallback, useEffect, useMemo, useRef } from "react";
import { usePathname, useRouter } from "expo-router";
import { getIsElectronRuntime } from "@/constants/layout";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { setCommandCenterFocusRestoreElement } from "@/utils/command-center-focus-restore";
import { getResidentBrowserWebview } from "@/components/browser-webview-resident";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { keyboardActionDispatcher } from "@/keyboard/keyboard-action-dispatcher";
import {
  type ChordState,
  type KeyboardShortcutInput,
  resolveKeyboardShortcut,
  buildEffectiveBindings,
  getWorkspaceIndexJumpModifierKey,
} from "@/keyboard/keyboard-shortcuts";
import { resolveKeyboardFocusScope } from "@/keyboard/focus-scope";
import {
  buildBrowserKeyboardPolicy,
  parseBrowserShortcutInput,
  shouldPublishBrowserShortcutPolicy,
} from "@/keyboard/browser-shortcuts";
import type { KeyboardFocusScope, KeyboardShortcutPayload } from "@/keyboard/actions";
import {
  routeKeyboardShortcut,
  type ShortcutAction,
  type ShortcutCallbackName,
} from "@/keyboard/route-shortcut";
import { getShortcutOs } from "@/utils/shortcut-platform";
import { useOpenAddProject } from "@/hooks/use-open-add-project";
import { useKeyboardShortcutOverrides } from "@/hooks/use-keyboard-shortcut-overrides";
import { isNative } from "@/constants/platform";
import { getDesktopHost, isElectronRuntime } from "@/desktop/host";
import { isImeComposingKeyboardEvent } from "@/utils/keyboard-ime";
import {
  type ActiveWorkspaceSelection,
  navigateToLastWorkspace,
  useActiveWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";

export function useKeyboardShortcuts({
  enabled,
  isMobile,
  toggleAgentList,
  toggleBothSidebars,
  cycleTheme,
}: {
  enabled: boolean;
  isMobile: boolean;
  toggleAgentList: () => void;
  toggleBothSidebars?: () => void;
  cycleTheme?: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const resetModifiers = useKeyboardShortcutsStore((s) => s.resetModifiers);
  const { overrides } = useKeyboardShortcutOverrides();
  const bindings = useMemo(() => buildEffectiveBindings(overrides), [overrides]);
  const isDesktopApp = getIsElectronRuntime();
  const isMac = getShortcutOs() === "mac";
  const chordStateRef = useRef<ChordState>({
    candidateIndices: [],
    step: 0,
    timeoutId: null,
  });
  const openProjectPickerAction = useOpenAddProject();
  const activeWorkspaceSelection = useActiveWorkspaceSelection();
  const keyboardWorkspaceSelectionRef = useRef<ActiveWorkspaceSelection | null>(null);

  const publishBrowserShortcutPolicy = useCallback(
    (chordState?: ChordState) => {
      const policy =
        enabled && !isMobile
          ? buildBrowserKeyboardPolicy({
              bindings,
              chordState,
              isMac,
              isDesktop: isDesktopApp,
            })
          : { menuPrefixes: [], prefixes: [] };
      void getDesktopHost()?.browser?.setShortcutPolicy?.(policy);
    },
    [bindings, enabled, isDesktopApp, isMac, isMobile],
  );

  useEffect(() => {
    if (activeWorkspaceSelection) {
      keyboardWorkspaceSelectionRef.current = activeWorkspaceSelection;
    }
  }, [activeWorkspaceSelection]);

  useEffect(() => {
    if (!isDesktopApp) {
      return;
    }

    publishBrowserShortcutPolicy();
  }, [isDesktopApp, publishBrowserShortcutPolicy]);

  useEffect(() => {
    if (!enabled) return;
    if (isNative) return;
    if (isMobile) return;

    // Only the modifier that actually performs the workspace-index jump on this
    // runtime should reveal the sidebar number badges (Alt on web, Cmd on
    // desktop Mac, Ctrl on desktop non-Mac). The store ORs altDown/cmdOrCtrlDown
    // to drive badge visibility, so we set the flag matching this runtime.
    const badgeModifierKey = getWorkspaceIndexJumpModifierKey({ isMac, isDesktop: isDesktopApp });
    const setBadgeModifierDown = (down: boolean) => {
      const state = useKeyboardShortcutsStore.getState();
      if (isDesktopApp) {
        state.setCmdOrCtrlDown(down);
      } else {
        state.setAltDown(down);
      }
    };

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
      "cycle-theme": cycleTheme,
    };

    const performShortcutAction = (
      action: ShortcutAction,
      event: KeyboardEvent | null,
      browserFocusRestoreElement: HTMLElement | null = null,
    ): boolean => {
      switch (action.kind) {
        case "none":
          return false;
        case "dispatch":
          return keyboardActionDispatcher.dispatch(action.action);
        case "navigate-workspace":
          keyboardWorkspaceSelectionRef.current = {
            serverId: action.serverId,
            workspaceId: action.workspaceId,
          };
          navigateToWorkspace({ serverId: action.serverId, workspaceId: action.workspaceId });
          return true;
        case "navigate-last-workspace":
          return navigateToLastWorkspace();
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
            if (event) {
              captureCommandCenterFocusRestore(event);
            } else {
              setCommandCenterFocusRestoreElement(browserFocusRestoreElement);
            }
          }
          useKeyboardShortcutsStore.getState().setCommandCenterOpen(action.nextOpen);
          return true;
        }
        case "shortcuts-dialog-toggle":
          useKeyboardShortcutsStore.getState().setShortcutsDialogOpen(action.nextOpen);
          return true;
      }
    };

    const routeAndPerformShortcut = (input: {
      action: string;
      payload: KeyboardShortcutPayload;
      domEvent: KeyboardEvent | null;
      browserFocusRestoreElement?: HTMLElement | null;
    }): boolean => {
      const store = useKeyboardShortcutsStore.getState();
      const shortcutAction = routeKeyboardShortcut(
        { action: input.action, payload: input.payload },
        {
          pathname,
          isMobile,
          sidebarShortcutTargets: store.sidebarShortcutWorkspaceTargets,
          navigationActiveWorkspace:
            keyboardWorkspaceSelectionRef.current ?? activeWorkspaceSelection,
          commandCenterOpen: store.commandCenterOpen,
          shortcutsDialogOpen: store.shortcutsDialogOpen,
        },
      );
      return performShortcutAction(
        shortcutAction,
        input.domEvent,
        input.browserFocusRestoreElement,
      );
    };

    const resolveAndPerformShortcut = (input: {
      event: KeyboardShortcutInput;
      focusScope: KeyboardFocusScope;
      domEvent: KeyboardEvent | null;
      browserFocusRestoreElement?: HTMLElement | null;
    }) => {
      const store = useKeyboardShortcutsStore.getState();
      const previousChordState = chordStateRef.current;
      const result = resolveKeyboardShortcut({
        event: input.event,
        context: {
          isMac,
          isDesktop: isDesktopApp,
          focusScope: input.focusScope,
          commandCenterOpen: store.commandCenterOpen,
        },
        chordState: chordStateRef.current,
        onChordReset: () => {
          chordStateRef.current = {
            candidateIndices: [],
            step: 0,
            timeoutId: null,
          };
          publishBrowserShortcutPolicy();
        },
        bindings,
      });

      chordStateRef.current = result.nextChordState;
      if (
        shouldPublishBrowserShortcutPolicy({
          isBrowserInput: "browserId" in input.event,
          previousChordState,
          nextChordState: result.nextChordState,
        })
      ) {
        publishBrowserShortcutPolicy(result.nextChordState);
      }

      if (result.preventDefault && input.domEvent) {
        input.domEvent.preventDefault();
        input.domEvent.stopPropagation();
      }

      if (!result.match) {
        return;
      }

      const handled = routeAndPerformShortcut({
        action: result.match.action,
        payload: result.match.payload,
        domEvent: input.domEvent,
        browserFocusRestoreElement: input.browserFocusRestoreElement,
      });
      if (!handled || !input.domEvent) {
        return;
      }

      if (result.match.preventDefault) {
        input.domEvent.preventDefault();
      }
      if (result.match.stopPropagation) {
        input.domEvent.stopPropagation();
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
      if (key === badgeModifierKey && !event.shiftKey) {
        setBadgeModifierDown(true);
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
      resolveAndPerformShortcut({
        event,
        focusScope,
        domEvent: event,
      });
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      const key = event.key ?? "";
      if (key === badgeModifierKey) {
        setBadgeModifierDown(false);
      }
    };

    const handleBlurOrHide = () => {
      resetModifiers();
    };

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("blur", handleBlurOrHide);
    document.addEventListener("visibilitychange", handleBlurOrHide);

    const browserShortcutSubscription = isElectronRuntime()
      ? getDesktopHost()?.events?.on?.("browser-shortcut-input", (payload) => {
          const input = parseBrowserShortcutInput(payload);
          if (!input) {
            return;
          }
          resolveAndPerformShortcut({
            event: input,
            focusScope: "browser",
            domEvent: null,
            browserFocusRestoreElement: getResidentBrowserWebview(input.browserId),
          });
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
      if (typeof browserShortcutSubscription === "function") {
        browserShortcutSubscription();
      } else {
        void browserShortcutSubscription?.then((dispose) => dispose());
      }
    };
  }, [
    bindings,
    cycleTheme,
    enabled,
    activeWorkspaceSelection,
    isDesktopApp,
    isMac,
    isMobile,
    openProjectPickerAction,
    pathname,
    publishBrowserShortcutPolicy,
    resetModifiers,
    router,
    toggleAgentList,
    toggleBothSidebars,
  ]);
}

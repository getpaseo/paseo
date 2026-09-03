import { useCallback, useEffect, useMemo, useRef } from "react";
import { AppState } from "react-native";
import { usePathname, useRouter } from "expo-router";
import { getIsElectronRuntime } from "@/constants/layout";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { setCommandCenterFocusRestoreElement } from "@/utils/command-center-focus-restore";
import { getResidentBrowserWebview } from "@/desktop/browser/resident-webviews";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useKeyboardActionDispatcher } from "@/keyboard/keyboard-action-dispatcher-context";
import {
  type ChordState,
  type KeyboardShortcutInput,
  resolveKeyboardShortcut,
  buildEffectiveBindings,
  getWorkspaceIndexJumpModifierKey,
} from "@/keyboard/keyboard-shortcuts";
import { ownsListNavigationKeys, resolveKeyboardFocusScope } from "@/keyboard/focus-scope";
import { resolveListSearchKeyAction } from "@/keyboard/list-search-keys";
import {
  buildBrowserKeyboardPolicy,
  parseBrowserShortcutInput,
  shouldPublishBrowserShortcutPolicy,
} from "@/desktop/browser/shortcuts";
import type { KeyboardFocusScope, KeyboardShortcutPayload } from "@/keyboard/actions";
import {
  routeKeyboardShortcut,
  type ShortcutAction,
  type ShortcutCallbackName,
} from "@/keyboard/route-shortcut";
import { useShortcutOs } from "@/utils/shortcut-platform";
import { useOpenAddProject } from "@/hooks/use-open-add-project";
import { useKeyboardShortcutOverrides } from "@/hooks/use-keyboard-shortcut-overrides";
import { isNative } from "@/constants/platform";
import { keyboardShortcutsAvailable } from "@/keyboard/availability";
import { requestComposerAutoFocus } from "@/keyboard/composer-auto-focus";
import {
  addHardwareKeyDownListener,
  addHardwareModifierListener,
  setHardwareKeyEventsEnabled,
} from "@/native/hardware-keyboard-events";
import { getDesktopHost, isElectronRuntime } from "@/desktop/host";
import { isImeComposingKeyboardEvent } from "@/utils/keyboard-ime";
import { buildOpenProjectRoute } from "@/utils/host-routes";
import { hasActiveWebOverlay } from "@/lib/overlay-root";
import {
  type ActiveWorkspaceSelection,
  navigateToLastWorkspace,
  useActiveWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { dispatchTopWebOverlayKeyDown } from "@/lib/overlay-root";
import { listSearchDispatcher } from "@/keyboard/list-search-dispatcher";
import { routeNativeListSearchBeforeShortcut } from "@/keyboard/native-list-search-routing";
import { hasFocusedTextInput } from "@/components/ui/text-input";

export function useKeyboardShortcuts({
  enabled,
  isMobile,
  isWorkspaceFocusModeEnabled,
  toggleAgentList,
  toggleBothSidebars,
  exitFocusMode,
  cycleTheme,
}: {
  enabled: boolean;
  isMobile: boolean;
  isWorkspaceFocusModeEnabled: boolean;
  toggleAgentList: () => void;
  toggleBothSidebars?: () => void;
  exitFocusMode: () => void;
  cycleTheme?: () => void;
}) {
  const keyboardActionDispatcher = useKeyboardActionDispatcher();
  const pathname = usePathname();
  const router = useRouter();
  const resetModifiers = useKeyboardShortcutsStore((s) => s.resetModifiers);
  const { overrides } = useKeyboardShortcutOverrides();
  const bindings = useMemo(() => buildEffectiveBindings(overrides), [overrides]);
  const shortcutsAvailable = keyboardShortcutsAvailable({ isNative, isCompact: isMobile });
  const isDesktopApp = getIsElectronRuntime();
  // Native apps have no browser reserving Cmd/Ctrl combos, so they use the
  // desktop binding variants; see usesDesktopShortcutBindings.
  const isDesktopBindings = isDesktopApp || isNative;
  const isMac = useShortcutOs() === "mac";
  const chordStateRef = useRef<ChordState>({
    candidateIndices: [],
    step: 0,
    timeoutId: null,
  });
  const openProjectPickerAction = useOpenAddProject();
  const activeWorkspaceSelection = useActiveWorkspaceSelection();
  const keyboardWorkspaceSelectionRef = useRef<ActiveWorkspaceSelection | null>(null);
  const badgeModifierKeyRef = useRef<string | null | undefined>(undefined);

  const publishBrowserShortcutPolicy = useCallback(
    (chordState?: ChordState) => {
      const policy =
        enabled && shortcutsAvailable
          ? buildBrowserKeyboardPolicy({
              bindings,
              chordState,
              isMac,
              isDesktop: isDesktopApp,
            })
          : { menuPrefixes: [], prefixes: [] };
      void getDesktopHost()?.browser?.setShortcutPolicy?.(policy);
    },
    [bindings, enabled, isDesktopApp, isMac, shortcutsAvailable],
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
    // On native, hardware-keyboard shortcuts flow through the Expo module
    // instead of DOM listeners; the compact-layout gate doesn't apply because
    // events only ever arrive from a connected hardware keyboard.
    if (!isNative && !shortcutsAvailable) return;

    // Only the modifier that actually performs the workspace-index jump on this
    // runtime should reveal the sidebar number badges (Alt on web, Cmd on
    // desktop Mac, Ctrl on desktop non-Mac). The store ORs altDown/cmdOrCtrlDown
    // to drive badge visibility, so we set the flag matching this runtime.
    // Derived from the effective bindings: `null` when the user unassigned or
    // rebound the jump shortcut, and no `event.key` ever equals null, so the
    // badges simply never appear.
    const badgeModifierKey = getWorkspaceIndexJumpModifierKey(
      { isMac, isDesktop: isDesktopBindings },
      bindings,
    );
    const setBadgeModifierDown = (down: boolean) => {
      const state = useKeyboardShortcutsStore.getState();
      if (isDesktopBindings) {
        state.setCmdOrCtrlDown(down);
      } else {
        state.setAltDown(down);
      }
    };

    // The keyup listener matches the released key against the modifier derived
    // when the effect last ran, so a modifier held while the jump binding
    // changes can never be released -- the badges would stay up until a blur.
    // Clear on change only: this effect also re-runs on every navigation, and
    // clearing unconditionally would drop the badges mid Cmd+1, Cmd+2.
    if (badgeModifierKeyRef.current !== badgeModifierKey) {
      badgeModifierKeyRef.current = badgeModifierKey;
      resetModifiers();
    }

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
          // A keyboard-driven workspace switch on native should land focus in
          // the composer so typing can continue without touching the screen.
          if (isNative) {
            requestComposerAutoFocus();
          }
          return true;
        case "navigate-last-workspace": {
          if (navigateToLastWorkspace()) {
            if (isNative) {
              requestComposerAutoFocus();
            }
            return true;
          }
          router.replace(buildOpenProjectRoute());
          return true;
        }
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
          useKeyboardShortcutsStore
            .getState()
            .setCommandCenterOpen(action.nextOpen, action.scope ?? null);
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
      const handled = performShortcutAction(
        shortcutAction,
        input.domEvent,
        input.browserFocusRestoreElement,
      );
      if (handled && isWorkspaceFocusModeEnabled && input.action.startsWith("sidebar.")) {
        exitFocusMode();
      }
      // If no mounted composer handled a focus request (terminal tab active,
      // screen mid-transition), leave a pending request so the next composer
      // to settle picks it up — Cmd/Ctrl+L should always land in the prompt.
      if (
        !handled &&
        isNative &&
        input.action === "message-input.action" &&
        input.payload &&
        typeof input.payload === "object" &&
        "kind" in input.payload &&
        input.payload.kind === "focus"
      ) {
        requestComposerAutoFocus();
        return true;
      }
      return handled;
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
          isDesktop: isDesktopBindings,
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

    if (isNative) {
      setHardwareKeyEventsEnabled(true);
      const subscription = addHardwareKeyDownListener((nativeEvent) => {
        const store = useKeyboardShortcutsStore.getState();
        if (store.capturingShortcut) {
          return;
        }
        // Native can't resolve DOM focus scopes; a focused TextInput is the
        // only text-editing surface, so it maps to "editable".
        const focusScope: KeyboardFocusScope = hasFocusedTextInput() ? "editable" : "other";
        routeNativeListSearchBeforeShortcut({
          event: nativeEvent,
          dispatchList: (event) => listSearchDispatcher.dispatch(event),
          dispatchShortcut: (event) =>
            resolveAndPerformShortcut({ event, focusScope, domEvent: null }),
        });
      });
      // Bare modifier presses drive the workspace-number badges, mirroring the
      // web keydown/keyup handling.
      const modifierSubscription = addHardwareModifierListener((modifierEvent) => {
        if (modifierEvent.key === badgeModifierKey) {
          setBadgeModifierDown(modifierEvent.down);
          return;
        }
        if (modifierEvent.key === "Shift" && modifierEvent.down) {
          const state = useKeyboardShortcutsStore.getState();
          if (state.altDown || state.cmdOrCtrlDown) {
            state.resetModifiers();
          }
        }
      });
      const appStateSubscription = AppState.addEventListener("change", (state) => {
        if (state !== "active") {
          resetModifiers();
        }
      });
      return () => {
        setHardwareKeyEventsEnabled(false);
        subscription.remove();
        modifierSubscription.remove();
        appStateSubscription.remove();
        resetModifiers();
        if (chordStateRef.current.timeoutId !== null) {
          clearTimeout(chordStateRef.current.timeoutId);
          chordStateRef.current = {
            candidateIndices: [],
            step: 0,
            timeoutId: null,
          };
        }
      };
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!shouldHandle()) {
        return;
      }

      if (dispatchTopWebOverlayKeyDown(event)) {
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

      if (resolveListSearchKeyAction(event) !== null && ownsListNavigationKeys(event.target)) {
        return;
      }

      const key = event.key ?? "";
      if (
        key === "Escape" &&
        pathname.startsWith("/settings") &&
        !isMobile &&
        hasActiveWebOverlay()
      ) {
        return;
      }
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
    exitFocusMode,
    activeWorkspaceSelection,
    isDesktopApp,
    isMac,
    isMobile,
    isWorkspaceFocusModeEnabled,
    keyboardActionDispatcher,
    openProjectPickerAction,
    pathname,
    publishBrowserShortcutPolicy,
    resetModifiers,
    router,
    isDesktopBindings,
    shortcutsAvailable,
    toggleAgentList,
    toggleBothSidebars,
  ]);
}

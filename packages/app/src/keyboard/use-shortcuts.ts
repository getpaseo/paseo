import { usesDesktopBindings } from "./internal/conventions";
import { createKeyboardPipeline } from "./internal/pipeline";
import { overlays } from "./internal/overlays";
import { attachKeyboardSources, publishKeyboardPolicy } from "./internal/sources";
import type { KeyboardSourceInput } from "./internal/sources/contract";
import type { KeyboardInputEvent } from "./internal/overlays";
import { hasActiveOverlay } from "./internal/overlay-dispatch";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { usePathname, useRouter } from "expo-router";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useKeyboardActionDispatcher } from "@/keyboard/keyboard-action-dispatcher-context";
import {
  type ChordState,
  buildEffectiveBindings,
  getWorkspaceIndexJumpModifierKey,
} from "@/keyboard/keyboard-shortcuts";
import { shouldPublishBrowserShortcutPolicy } from "@/keyboard/internal/sources/electron-browser";
import type { KeyboardShortcutPayload } from "@/keyboard/actions";
import {
  routeKeyboardShortcut,
  type ShortcutAction,
  type ShortcutCallbackName,
} from "@/keyboard/route-shortcut";
import { getShortcutOs } from "@/utils/shortcut-platform";
import { useOpenAddProject } from "@/hooks/use-open-add-project";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useKeyboardShortcutOverrides } from "@/hooks/use-keyboard-shortcut-overrides";
import { buildOpenProjectRoute } from "@/utils/host-routes";
import {
  type ActiveWorkspaceSelection,
  navigateToLastWorkspace,
  useActiveWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";

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
  const isMac = getShortcutOs() === "mac";
  const openProjectPickerAction = useOpenAddProject();
  const activeWorkspaceSelection = useActiveWorkspaceSelection();
  const keyboardWorkspaceSelectionRef = useRef<ActiveWorkspaceSelection | null>(null);
  const publishBrowserShortcutPolicy = useCallback(
    (chordState?: ChordState) => {
      publishKeyboardPolicy({ bindings, chordState, isMac, usesDesktopBindings, enabled });
    },
    [bindings, enabled, isMac],
  );

  useEffect(() => {
    if (activeWorkspaceSelection) {
      keyboardWorkspaceSelectionRef.current = activeWorkspaceSelection;
    }
  }, [activeWorkspaceSelection]);

  useEffect(() => {
    publishBrowserShortcutPolicy();
  }, [publishBrowserShortcutPolicy]);

  // Only the modifier that actually performs the workspace-index jump on this
  // runtime should reveal the sidebar number badges (Alt on web, Cmd on
  // desktop Mac, Ctrl on desktop non-Mac). The store ORs altDown/cmdOrCtrlDown
  // to drive badge visibility, so we set the flag matching this runtime.
  // Derived from the effective bindings: `null` when the user unassigned or
  // rebound the jump shortcut, and no `event.key` ever equals null, so the
  // badges simply never appear.
  const badgeModifierKey = getWorkspaceIndexJumpModifierKey(
    { isMac, usesDesktopBindings: usesDesktopBindings },
    bindings,
  );

  // The keyup listener matches the released key against the current modifier,
  // so a modifier held while the jump binding changes could never be released
  // and the badges would stay up until a blur. Clear them when it changes.
  useEffect(() => {
    resetModifiers();
  }, [badgeModifierKey, resetModifiers]);

  const setBadgeModifierDown = (down: boolean) => {
    const state = useKeyboardShortcutsStore.getState();
    if (usesDesktopBindings) {
      state.setCmdOrCtrlDown(down);
    } else {
      state.setAltDown(down);
    }
  };

  const callbacksByName: Record<ShortcutCallbackName, (() => void) | undefined> = {
    "toggle-agent-list": toggleAgentList,
    "toggle-both-sidebars": toggleBothSidebars,
    "cycle-theme": cycleTheme,
  };

  const performShortcutAction = (
    action: ShortcutAction,
    captureFocusRestore: () => void,
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
        if (navigateToLastWorkspace()) {
          return true;
        }
        router.replace(buildOpenProjectRoute());
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
          captureFocusRestore();
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
    captureFocusRestore: () => void;
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
    const handled = performShortcutAction(shortcutAction, input.captureFocusRestore);
    if (handled && isWorkspaceFocusModeEnabled && input.action.startsWith("sidebar.")) {
      exitFocusMode();
    }
    return handled;
  };

  const getContext = useStableEvent(() => ({
    isMac,
    usesDesktopBindings: usesDesktopBindings,
    commandCenterOpen: useKeyboardShortcutsStore.getState().commandCenterOpen,
  }));
  const getBindings = useStableEvent(() => bindings);
  const isCapturing = useStableEvent(() => useKeyboardShortcutsStore.getState().capturingShortcut);
  const dispatchMatch = useStableEvent(
    (match: import("./keyboard-shortcuts").KeyboardShortcutMatch, input: KeyboardSourceInput) =>
      routeAndPerformShortcut({
        action: match.action,
        payload: match.payload,
        captureFocusRestore: input.captureFocusRestore,
      }),
  );
  const chordChanged = useStableEvent(
    (previous: ChordState, next: ChordState, input: KeyboardSourceInput | null) => {
      const isBrowserInput = input !== null && "browserId" in input.event;
      if (
        !input ||
        shouldPublishBrowserShortcutPolicy({
          isBrowserInput,
          previousChordState: previous,
          nextChordState: next,
        })
      ) {
        publishBrowserShortcutPolicy(next);
      }
    },
  );
  const beforeResolve = useStableEvent((input: KeyboardSourceInput) => {
    const event = input.event;
    const key = event.key ?? "";
    if (key === "Escape" && pathname.startsWith("/settings") && !isMobile && hasActiveOverlay()) {
      return false;
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

    return true;
  });

  const pipeline = useMemo(
    () =>
      createKeyboardPipeline({
        getContext,
        getBindings,
        isCapturing,
        dispatch: dispatchMatch,
        overlays,
        beforeResolve,
        chordChanged,
      }),
    [getContext, getBindings, isCapturing, dispatchMatch, beforeResolve, chordChanged],
  );

  const handleKeyUp = useStableEvent((event: KeyboardInputEvent) => {
    const key = event.key ?? "";
    if (key === badgeModifierKey) {
      setBadgeModifierDown(false);
    }
  });

  useEffect(() => {
    if (!enabled) return;
    const detach = attachKeyboardSources({
      keyDown: pipeline.keyDown,
      keyUp: handleKeyUp,
      blur: resetModifiers,
      commandCenterOpen: () => useKeyboardShortcutsStore.getState().commandCenterOpen,
      subscribeCommandCenter: (listener) =>
        useKeyboardShortcutsStore.subscribe((state, previous) => {
          if (state.commandCenterOpen !== previous.commandCenterOpen) listener();
        }),
    });
    return () => {
      detach();
      pipeline.dispose();
    };
  }, [enabled, pipeline, handleKeyUp, resetModifiers]);
}

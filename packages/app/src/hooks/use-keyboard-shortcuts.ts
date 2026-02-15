import { useEffect } from "react";
import { Platform } from "react-native";
import { usePathname, useRouter } from "expo-router";
import { getIsTauri } from "@/constants/layout";
import { useSessionStore } from "@/stores/session-store";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { parseSidebarAgentKey } from "@/utils/sidebar-shortcuts";
import { setCommandCenterFocusRestoreElement } from "@/utils/command-center-focus-restore";
import {
  checkoutStatusQueryKey,
  type CheckoutStatusPayload,
} from "@/hooks/use-checkout-status-query";
import { queryClient } from "@/query/query-client";
import {
  buildNewAgentRoute,
  resolveSelectedAgentForNewAgent,
  resolveNewAgentWorkingDir,
} from "@/utils/new-agent-routing";
import {
  buildHostAgentDetailRoute,
  parseHostAgentDraftRouteFromPathname,
  parseHostAgentRouteFromPathname,
  parseServerIdFromPathname,
} from "@/utils/host-routes";
import {
  type MessageInputKeyboardActionKind,
  type KeyboardShortcutPayload,
} from "@/keyboard/actions";
import { resolveKeyboardShortcut } from "@/keyboard/keyboard-shortcuts";
import { resolveKeyboardFocusScope } from "@/keyboard/focus-scope";
import { getShortcutOs } from "@/utils/shortcut-platform";

function resolveSelectedOrRouteAgentKey(input: {
  selectedAgentId?: string;
  pathname: string;
}): string | null {
  const DRAFT_AGENT_ID = "__new_agent__";
  if (input.selectedAgentId) {
    return input.selectedAgentId;
  }
  const route = parseHostAgentRouteFromPathname(input.pathname);
  if (!route) {
    const draftRoute = parseHostAgentDraftRouteFromPathname(input.pathname);
    if (!draftRoute) {
      return null;
    }
    return `${draftRoute.serverId}:${DRAFT_AGENT_ID}`;
  }
  return `${route.serverId}:${route.agentId}`;
}

export function useKeyboardShortcuts({
  enabled,
  isMobile,
  toggleAgentList,
  selectedAgentId,
  toggleFileExplorer,
}: {
  enabled: boolean;
  isMobile: boolean;
  toggleAgentList: () => void;
  selectedAgentId?: string;
  toggleFileExplorer?: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const resetModifiers = useKeyboardShortcutsStore((s) => s.resetModifiers);

  useEffect(() => {
    if (!enabled) return;
    if (Platform.OS !== "web") return;
    if (isMobile) return;

    const isTauri = getIsTauri();
    const isMac = getShortcutOs() === "mac";

    const shouldHandle = () => {
      if (typeof document === "undefined") return false;
      if (document.visibilityState !== "visible") return false;
      return true;
    };

    const navigateToSidebarShortcut = (digit: number): boolean => {
      const state = useKeyboardShortcutsStore.getState();
      const targetKey = state.sidebarShortcutAgentKeys[digit - 1] ?? null;
      if (!targetKey) {
        return false;
      }

      const parsed = parseSidebarAgentKey(targetKey);
      if (!parsed) {
        return false;
      }
      const { serverId, agentId } = parsed;

      const shouldReplace = Boolean(parseHostAgentRouteFromPathname(pathname));
      const navigate = shouldReplace ? router.replace : router.push;
      navigate(buildHostAgentDetailRoute(serverId, agentId) as any);
      return true;
    };

    const navigateToNewAgent = (): boolean => {
      let targetServerId = parseServerIdFromPathname(pathname);
      let targetWorkingDir: string | null = null;
      const selectedAgent = resolveSelectedAgentForNewAgent({
        pathname,
        selectedAgentId,
      });
      if (selectedAgent) {
        targetServerId = selectedAgent.serverId;
        const agent = useSessionStore
          .getState()
          .sessions[selectedAgent.serverId]
          ?.agents?.get(selectedAgent.agentId);
        const cwd = agent?.cwd?.trim();
        if (cwd) {
          const checkout =
            queryClient.getQueryData<CheckoutStatusPayload>(
              checkoutStatusQueryKey(selectedAgent.serverId, cwd)
            ) ?? null;
          targetWorkingDir = resolveNewAgentWorkingDir(cwd, checkout);
        }
      }

      if (!targetServerId) {
        const sessionServerIds = Object.keys(useSessionStore.getState().sessions);
        targetServerId = sessionServerIds[0] ?? null;
      }

      if (!targetServerId) {
        return false;
      }

      router.push(buildNewAgentRoute(targetServerId, targetWorkingDir) as any);
      return true;
    };

    const requestMessageInputAction = (
      kind: MessageInputKeyboardActionKind
    ): boolean => {
      const agentKey = resolveSelectedOrRouteAgentKey({ selectedAgentId, pathname });
      if (!agentKey) {
        return false;
      }
      useKeyboardShortcutsStore.getState().requestMessageInputAction({
        agentKey,
        kind,
      });
      return true;
    };

    const handleAction = (input: {
      action: string;
      payload: KeyboardShortcutPayload;
      event: KeyboardEvent;
    }): boolean => {
      switch (input.action) {
        case "agent.new":
          return navigateToNewAgent();
        case "sidebar.toggle.left":
          toggleAgentList();
          return true;
        case "sidebar.toggle.right":
          if (!selectedAgentId || !toggleFileExplorer) {
            return false;
          }
          toggleFileExplorer();
          return true;
        case "sidebar.navigate.shortcut":
          if (!input.payload || typeof input.payload !== "object" || !("digit" in input.payload)) {
            return false;
          }
          return navigateToSidebarShortcut(input.payload.digit);
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
              (targetEl as HTMLElement | null) ?? activeEl ?? null
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
          return requestMessageInputAction(input.payload.kind);
        default:
          return false;
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!shouldHandle()) {
        return;
      }

      const key = event.key ?? "";
      if (key === "Alt" && !event.shiftKey) {
        useKeyboardShortcutsStore.getState().setAltDown(true);
      }
      if (isTauri && (key === "Meta" || key === "Control") && !event.shiftKey) {
        useKeyboardShortcutsStore.getState().setCmdOrCtrlDown(true);
      }
      if (key === "Shift") {
        const state = useKeyboardShortcutsStore.getState();
        if (state.altDown || state.cmdOrCtrlDown) {
          state.resetModifiers();
        }
      }

      const store = useKeyboardShortcutsStore.getState();
      const focusScope = resolveKeyboardFocusScope({
        target: event.target,
        commandCenterOpen: store.commandCenterOpen,
      });
      const match = resolveKeyboardShortcut({
        event,
        context: {
          isMac,
          isTauri,
          focusScope,
          commandCenterOpen: store.commandCenterOpen,
          hasSelectedAgent: Boolean(selectedAgentId && toggleFileExplorer),
        },
      });
      if (!match) {
        return;
      }

      const handled = handleAction({
        action: match.action,
        payload: match.payload,
        event,
      });
      if (!handled) {
        return;
      }

      if (match.preventDefault) {
        event.preventDefault();
      }
      if (match.stopPropagation) {
        event.stopPropagation();
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      const key = event.key ?? "";
      if (key === "Alt") {
        useKeyboardShortcutsStore.getState().setAltDown(false);
      }
      if (isTauri && (key === "Meta" || key === "Control")) {
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
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("blur", handleBlurOrHide);
      document.removeEventListener("visibilitychange", handleBlurOrHide);
    };
  }, [
    enabled,
    isMobile,
    pathname,
    resetModifiers,
    router,
    selectedAgentId,
    toggleAgentList,
    toggleFileExplorer,
  ]);
}

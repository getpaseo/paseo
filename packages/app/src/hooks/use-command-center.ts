import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TextInput } from "react-native";
import { router, usePathname } from "expo-router";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { useAggregatedAgents, type AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { useSessionStore } from "@/stores/session-store";
import {
  checkoutStatusQueryKey,
  type CheckoutStatusPayload,
} from "@/hooks/use-checkout-status-query";
import { queryClient } from "@/query/query-client";
import {
  clearCommandCenterFocusRestoreElement,
  takeCommandCenterFocusRestoreElement,
} from "@/utils/command-center-focus-restore";
import {
  buildNewAgentRoute,
  resolveNewAgentWorkingDir,
} from "@/utils/new-agent-routing";
import {
  buildHostAgentDetailRoute,
  buildHostSettingsRoute,
  parseHostAgentRouteFromPathname,
  parseServerIdFromPathname,
} from "@/utils/host-routes";
import type { ShortcutKey } from "@/utils/format-shortcut";
import { focusWithRetries } from "@/utils/web-focus";

function agentKey(agent: Pick<AggregatedAgent, "serverId" | "id">): string {
  return `${agent.serverId}:${agent.id}`;
}

function isMatch(agent: AggregatedAgent, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const title = (agent.title ?? "New agent").toLowerCase();
  const cwd = agent.cwd.toLowerCase();
  const host = agent.serverLabel.toLowerCase();
  return title.includes(q) || cwd.includes(q) || host.includes(q);
}

function sortAgents(left: AggregatedAgent, right: AggregatedAgent): number {
  const leftNeedsInput = (left.pendingPermissionCount ?? 0) > 0 ? 1 : 0;
  const rightNeedsInput = (right.pendingPermissionCount ?? 0) > 0 ? 1 : 0;
  if (leftNeedsInput !== rightNeedsInput) return rightNeedsInput - leftNeedsInput;

  const leftAttention = left.requiresAttention ? 1 : 0;
  const rightAttention = right.requiresAttention ? 1 : 0;
  if (leftAttention !== rightAttention) return rightAttention - leftAttention;

  const leftRunning = left.status === "running" ? 1 : 0;
  const rightRunning = right.status === "running" ? 1 : 0;
  if (leftRunning !== rightRunning) return rightRunning - leftRunning;

  return right.lastActivityAt.getTime() - left.lastActivityAt.getTime();
}

function parseAgentKeyFromPathname(pathname: string): string | null {
  const match = parseHostAgentRouteFromPathname(pathname);
  if (!match) {
    return null;
  }
  return `${match.serverId}:${match.agentId}`;
}

function parseAgentRouteFromPathname(
  pathname: string
): { serverId: string; agentId: string } | null {
  return parseHostAgentRouteFromPathname(pathname);
}

type CommandCenterActionDefinition = {
  id: string;
  title: string;
  icon?: "plus" | "settings";
  shortcutKeys?: ShortcutKey[];
  keywords: string[];
  buildRoute: (params: { newAgentRoute: string; settingsRoute: string }) => string;
};

const COMMAND_CENTER_ACTIONS: readonly CommandCenterActionDefinition[] = [
  {
    id: "new-agent",
    title: "New agent",
    icon: "plus",
    shortcutKeys: ["mod", "alt", "N"],
    keywords: ["new", "new agent", "create", "start", "launch", "agent"],
    buildRoute: ({ newAgentRoute }) => newAgentRoute,
  },
  {
    id: "settings",
    title: "Settings",
    icon: "settings",
    keywords: ["settings", "preferences", "config", "configuration"],
    buildRoute: ({ settingsRoute }) => settingsRoute,
  },
];

function matchesActionQuery(
  query: string,
  action: CommandCenterActionDefinition
): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  if (action.title.toLowerCase().includes(normalized)) {
    return true;
  }
  return action.keywords.some((keyword) => keyword.includes(normalized));
}

export type CommandCenterActionItem = {
  kind: "action";
  id: string;
  title: string;
  icon?: "plus" | "settings";
  route: string;
  shortcutKeys?: ShortcutKey[];
};

export type CommandCenterItem =
  | {
      kind: "action";
      action: CommandCenterActionItem;
    }
  | {
      kind: "agent";
      agent: AggregatedAgent;
    };

export function useCommandCenter() {
  const pathname = usePathname();
  const { agents } = useAggregatedAgents();
  const open = useKeyboardShortcutsStore((s) => s.commandCenterOpen);
  const setOpen = useKeyboardShortcutsStore((s) => s.setCommandCenterOpen);
  const requestMessageInputAction = useKeyboardShortcutsStore(
    (s) => s.requestMessageInputAction
  );
  const inputRef = useRef<TextInput>(null);
  const didNavigateRef = useRef(false);
  const prevOpenRef = useRef(open);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const agentResults = useMemo(() => {
    const filtered = agents.filter((agent) => isMatch(agent, query));
    filtered.sort(sortAgents);
    return filtered;
  }, [agents, query]);

  const fallbackServerId = agents[0]?.serverId ?? null;

  const agentKeyFromPathname = useMemo(
    () => parseAgentKeyFromPathname(pathname),
    [pathname]
  );

  const newAgentRoute = useMemo(() => {
    const serverIdFromPath =
      parseServerIdFromPathname(pathname) ?? fallbackServerId;
    const routeAgent = parseAgentRouteFromPathname(pathname);
    if (!routeAgent) {
      return serverIdFromPath ? buildNewAgentRoute(serverIdFromPath) : "/";
    }

    const { serverId, agentId } = routeAgent;
    const currentAgent = useSessionStore.getState().sessions[serverId]?.agents?.get(agentId);
    const cwd = currentAgent?.cwd?.trim();
    if (!cwd) {
      return buildNewAgentRoute(serverId);
    }

    const checkout =
      queryClient.getQueryData<CheckoutStatusPayload>(
        checkoutStatusQueryKey(serverId, cwd)
      ) ?? null;
    const workingDir = resolveNewAgentWorkingDir(cwd, checkout);
    return buildNewAgentRoute(serverId, workingDir);
  }, [fallbackServerId, pathname]);

  const settingsRoute = useMemo(() => {
    const serverIdFromPath =
      parseServerIdFromPathname(pathname) ?? fallbackServerId;
    return serverIdFromPath ? buildHostSettingsRoute(serverIdFromPath) : "/";
  }, [fallbackServerId, pathname]);

  const actionItems = useMemo(() => {
    return COMMAND_CENTER_ACTIONS.filter((action) =>
      matchesActionQuery(query, action)
    ).map<CommandCenterActionItem>((action) => ({
      kind: "action",
      id: action.id,
      title: action.title,
      icon: action.icon,
      route: action.buildRoute({ newAgentRoute, settingsRoute }),
      shortcutKeys: action.shortcutKeys,
    }));
  }, [newAgentRoute, query, settingsRoute]);

  const items = useMemo(() => {
    const next: CommandCenterItem[] = [];
    for (const action of actionItems) {
      next.push({
        kind: "action",
        action,
      });
    }
    for (const agent of agentResults) {
      next.push({
        kind: "agent",
        agent,
      });
    }
    return next;
  }, [actionItems, agentResults]);

  const handleClose = useCallback(() => {
    setOpen(false);
  }, [setOpen]);

  const handleSelectAgent = useCallback(
    (agent: AggregatedAgent) => {
      didNavigateRef.current = true;
      const shouldReplace = Boolean(parseHostAgentRouteFromPathname(pathname));
      const navigate = shouldReplace ? router.replace : router.push;

      requestMessageInputAction({
        agentKey: agentKey(agent),
        kind: "focus",
      });
      // Don't restore focus back to the prior element after we navigate.
      clearCommandCenterFocusRestoreElement();
      setOpen(false);
      navigate(buildHostAgentDetailRoute(agent.serverId, agent.id) as any);
    },
    [pathname, requestMessageInputAction, setOpen]
  );

  const handleSelectAction = useCallback((action: CommandCenterActionItem) => {
    didNavigateRef.current = true;
    clearCommandCenterFocusRestoreElement();
    setOpen(false);
    router.push(action.route as any);
  }, [setOpen]);

  const handleSelectItem = useCallback(
    (item: CommandCenterItem) => {
      if (item.kind === "action") {
        handleSelectAction(item.action);
        return;
      }
      handleSelectAgent(item.agent);
    },
    [handleSelectAction, handleSelectAgent]
  );

  useEffect(() => {
    const prevOpen = prevOpenRef.current;
    prevOpenRef.current = open;

    if (!open) {
      setQuery("");
      setActiveIndex(0);

      if (prevOpen && !didNavigateRef.current) {
        const el = takeCommandCenterFocusRestoreElement();
        const isFocused = () =>
          Boolean(el) &&
          typeof document !== "undefined" &&
          document.activeElement === el;

        const cancel = focusWithRetries({
          focus: () => el?.focus(),
          isFocused,
          onTimeout: () => {
            if (agentKeyFromPathname) {
              requestMessageInputAction({
                agentKey: agentKeyFromPathname,
                kind: "focus",
              });
            }
          },
        });
        return cancel;
      }

      return;
    }

    didNavigateRef.current = false;

    const id = setTimeout(() => {
      inputRef.current?.focus();
    }, 0);
    return () => clearTimeout(id);
  }, [agentKeyFromPathname, open, requestMessageInputAction]);

  useEffect(() => {
    if (!open) return;
    if (activeIndex >= items.length) {
      setActiveIndex(items.length > 0 ? items.length - 1 : 0);
    }
  }, [activeIndex, items.length, open]);

  useEffect(() => {
    if (!open) return;

    const handler = (event: KeyboardEvent) => {
      const key = event.key;
      if (
        key !== "ArrowDown" &&
        key !== "ArrowUp" &&
        key !== "Enter" &&
        key !== "Escape"
      ) {
        return;
      }

      if (key === "Escape") {
        event.preventDefault();
        handleClose();
        return;
      }

      if (key === "Enter") {
        if (items.length === 0) return;
        event.preventDefault();
        const index = Math.max(0, Math.min(activeIndex, items.length - 1));
        handleSelectItem(items[index]!);
        return;
      }

      if (key === "ArrowDown" || key === "ArrowUp") {
        if (items.length === 0) return;
        event.preventDefault();
        setActiveIndex((current) => {
          const delta = key === "ArrowDown" ? 1 : -1;
          const next = current + delta;
          if (next < 0) return items.length - 1;
          if (next >= items.length) return 0;
          return next;
        });
      }
    };

    // react-native-web can stop propagation on key events, so listen in capture phase.
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [activeIndex, handleClose, handleSelectItem, items, open]);

  return {
    open,
    inputRef,
    query,
    setQuery,
    activeIndex,
    setActiveIndex,
    items,
    handleClose,
    handleSelectItem,
  };
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TextInput } from "react-native";
import { router, usePathname } from "expo-router";
import { useKeyboardNavStore } from "@/stores/keyboard-nav-store";
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
  const leftAttention = left.requiresAttention ? 1 : 0;
  const rightAttention = right.requiresAttention ? 1 : 0;
  if (leftAttention !== rightAttention) return rightAttention - leftAttention;

  const leftRunning = left.status === "running" ? 1 : 0;
  const rightRunning = right.status === "running" ? 1 : 0;
  if (leftRunning !== rightRunning) return rightRunning - leftRunning;

  return right.lastActivityAt.getTime() - left.lastActivityAt.getTime();
}

function parseAgentKeyFromPathname(pathname: string): string | null {
  const match = pathname.match(/^\/agent\/([^/]+)\/([^/]+)/);
  if (!match) return null;
  return `${match[1]}:${match[2]}`;
}

function parseAgentRouteFromPathname(
  pathname: string
): { serverId: string; agentId: string } | null {
  const match = pathname.match(/^\/agent\/([^/]+)\/([^/]+)/);
  if (!match) return null;
  const [, serverId, agentId] = match;
  if (!serverId || !agentId) return null;
  return { serverId, agentId };
}

type CommandCenterActionDefinition = {
  id: string;
  title: string;
  icon?: "plus" | "settings";
  shortcutKeys?: ShortcutKey[];
  keywords: string[];
  buildRoute: (params: { newAgentRoute: string }) => string;
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
    buildRoute: () => "/settings",
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
  const open = useKeyboardNavStore((s) => s.commandCenterOpen);
  const setOpen = useKeyboardNavStore((s) => s.setCommandCenterOpen);
  const requestFocusChatInput = useKeyboardNavStore((s) => s.requestFocusChatInput);
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

  const agentKeyFromPathname = useMemo(
    () => parseAgentKeyFromPathname(pathname),
    [pathname]
  );

  const newAgentRoute = useMemo(() => {
    const routeAgent = parseAgentRouteFromPathname(pathname);
    if (!routeAgent) {
      return "/agent";
    }

    const { serverId, agentId } = routeAgent;
    const currentAgent = useSessionStore.getState().sessions[serverId]?.agents?.get(agentId);
    const cwd = currentAgent?.cwd?.trim();
    if (!cwd) {
      return "/agent";
    }

    const checkout =
      queryClient.getQueryData<CheckoutStatusPayload>(
        checkoutStatusQueryKey(serverId, cwd)
      ) ?? null;
    const workingDir = resolveNewAgentWorkingDir(cwd, checkout);
    return buildNewAgentRoute(workingDir);
  }, [pathname]);

  const actionItems = useMemo(() => {
    return COMMAND_CENTER_ACTIONS.filter((action) =>
      matchesActionQuery(query, action)
    ).map<CommandCenterActionItem>((action) => ({
      kind: "action",
      id: action.id,
      title: action.title,
      icon: action.icon,
      route: action.buildRoute({ newAgentRoute }),
      shortcutKeys: action.shortcutKeys,
    }));
  }, [newAgentRoute, query]);

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
      const session = useSessionStore.getState().sessions[agent.serverId];
      session?.client?.clearAgentAttention(agent.id);

      const shouldReplace = pathname.startsWith("/agent/");
      const navigate = shouldReplace ? router.replace : router.push;

      requestFocusChatInput(agentKey(agent));
      // Don't restore focus back to the prior element after we navigate.
      clearCommandCenterFocusRestoreElement();
      setOpen(false);
      navigate(`/agent/${agent.serverId}/${agent.id}` as any);
    },
    [pathname, requestFocusChatInput, setOpen]
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
              requestFocusChatInput(agentKeyFromPathname);
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
  }, [agentKeyFromPathname, open, requestFocusChatInput]);

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

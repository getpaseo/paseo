import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TextInput } from "react-native";
import { router, type Href } from "expo-router";
import { useTranslation } from "react-i18next";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { keyboardActionDispatcher } from "@/keyboard/keyboard-action-dispatcher";
import { useAggregatedAgents, type AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { useAddProjectFlowStore } from "@/stores/add-project-flow-store";
import {
  clearCommandCenterFocusRestoreElement,
  takeCommandCenterFocusRestoreElement,
} from "@/utils/command-center-focus-restore";
import { buildOpenProjectRoute, buildSettingsRoute } from "@/utils/host-routes";
import type { ShortcutKey } from "@/utils/format-shortcut";
import { chordStringToShortcutKeys } from "@/keyboard/shortcut-string";
import { getBindingIdForAction, getDefaultKeysForAction } from "@/keyboard/keyboard-shortcuts";
import { useKeyboardShortcutOverrides } from "@/hooks/use-keyboard-shortcut-overrides";
import { getShortcutOs } from "@/utils/shortcut-platform";
import { getIsElectronRuntime } from "@/constants/layout";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { focusWithRetries } from "@/utils/web-focus";
import { isWeb } from "@/constants/platform";
import { useProjects } from "@/hooks/use-projects";
import { useHosts } from "@/runtime/host-runtime";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { formatTimeAgo } from "@/utils/time";
import { shortenPath } from "@/utils/shorten-path";

const EMPTY_ACTION_ITEMS: CommandCenterActionItem[] = [];
const EMPTY_WORKSPACE_ITEMS: CommandCenterWorkspaceItem[] = [];
const EMPTY_AGENT_ITEMS: CommandCenterAgentItem[] = [];
const EMPTY_COMMAND_CENTER_ITEMS: CommandCenterItem[] = [];

function buildSearchText(...fields: string[]): string {
  return fields.join(" ").toLowerCase();
}

function matchesQuery(searchText: string, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  return !normalized || searchText.includes(normalized);
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

interface CommandCenterActionDefinition {
  id: string;
  titleKey:
    | "shell.commandCenter.addProject"
    | "shell.commandCenter.home"
    | "sidebar.actions.settings";
  icon?: "plus" | "settings" | "home";
  actionId?: string;
  keywords: string[];
  routeKind: "settings" | "home" | "none";
}

const COMMAND_CENTER_ACTIONS: readonly CommandCenterActionDefinition[] = [
  {
    id: "new-agent",
    titleKey: "shell.commandCenter.addProject",
    icon: "plus",
    actionId: "new-agent",
    keywords: ["open", "project", "folder", "workspace", "repo"],
    routeKind: "none",
  },
  {
    id: "home",
    titleKey: "shell.commandCenter.home",
    icon: "home",
    keywords: ["home", "start", "import", "session", "pair", "device", "providers"],
    routeKind: "home",
  },
  {
    id: "settings",
    titleKey: "sidebar.actions.settings",
    icon: "settings",
    keywords: ["settings", "preferences", "config", "configuration"],
    routeKind: "settings",
  },
];

export interface CommandCenterActionItem {
  kind: "action";
  id: string;
  title: string;
  icon?: "plus" | "settings" | "home";
  route?: Href;
  shortcutKeys?: ShortcutKey[][];
  searchText: string;
}

export interface CommandCenterWorkspaceItem {
  kind: "workspace";
  serverId: string;
  workspaceId: string;
  title: string;
  subtitle: string;
  searchText: string;
}

export interface CommandCenterAgentItem {
  kind: "agent";
  agent: AggregatedAgent;
  title: string;
  subtitle: string;
  searchText: string;
}

export type CommandCenterItem =
  | CommandCenterActionItem
  | CommandCenterWorkspaceItem
  | CommandCenterAgentItem;

function resolveActionShortcutKeys(
  actionId: string | undefined,
  overrides: Record<string, string>,
): ShortcutKey[][] | undefined {
  if (!actionId) return undefined;
  const isMac = getShortcutOs() === "mac";
  const isDesktopApp = getIsElectronRuntime();
  const platform = { isMac, isDesktop: isDesktopApp };
  const bindingId = getBindingIdForAction(actionId, platform);
  if (!bindingId) return undefined;
  const override = overrides[bindingId];
  if (override) return chordStringToShortcutKeys(override);
  const defaultKeys = getDefaultKeysForAction(actionId, platform);
  return defaultKeys ? [defaultKeys] : undefined;
}

export function useCommandCenter() {
  const { t } = useTranslation();
  const { overrides } = useKeyboardShortcutOverrides();
  const open = useKeyboardShortcutsStore((s) => s.commandCenterOpen);
  const setOpen = useKeyboardShortcutsStore((s) => s.setCommandCenterOpen);
  const addProjectRequest = useAddProjectFlowStore((state) => state.request);
  const openAddProjectFlow = useAddProjectFlowStore((state) => state.open);
  const closeAddProjectFlow = useAddProjectFlowStore((state) => state.close);
  const inputRef = useRef<TextInput>(null);
  const didNavigateRef = useRef(false);
  const prevOpenRef = useRef(open);
  const activeIndexRef = useRef(0);
  const itemsRef = useRef<CommandCenterItem[]>([]);
  const handleCloseRef = useRef<() => void>(() => undefined);
  const handleSelectItemRef = useRef<(item: CommandCenterItem) => void>(() => undefined);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const { agents } = useAggregatedAgents();
  const { projects } = useProjects({ enabled: open });
  const hosts = useHosts();
  const showAgentHost = hosts.length > 1;

  const allWorkspaceItems = useMemo(() => {
    const results: CommandCenterWorkspaceItem[] = [];
    for (const project of projects) {
      for (const host of project.hosts) {
        for (const workspace of host.workspaces) {
          if (workspace.archivingAt) continue;
          const title = workspace.title ?? workspace.name;
          const subtitle = workspace.currentBranch
            ? `${host.serverName} · ${workspace.currentBranch}`
            : host.serverName;
          results.push({
            kind: "workspace",
            serverId: host.serverId,
            workspaceId: workspace.id,
            title,
            subtitle,
            searchText: buildSearchText(title, subtitle),
          });
        }
      }
    }
    results.sort((left, right) => {
      const titleDelta = left.title.localeCompare(right.title, undefined, {
        numeric: true,
        sensitivity: "base",
      });
      if (titleDelta !== 0) return titleDelta;
      const hostDelta = left.subtitle.localeCompare(right.subtitle, undefined, {
        numeric: true,
        sensitivity: "base",
      });
      if (hostDelta !== 0) return hostDelta;
      return `${left.serverId}:${left.workspaceId}`.localeCompare(
        `${right.serverId}:${right.workspaceId}`,
      );
    });
    return results;
  }, [projects]);

  const workspaceTitleByKey = useMemo(
    () =>
      new Map(
        allWorkspaceItems.map((workspace) => [
          `${workspace.serverId}:${workspace.workspaceId}`,
          workspace.title,
        ]),
      ),
    [allWorkspaceItems],
  );

  const workspaceResults = useMemo(() => {
    if (!open || allWorkspaceItems.length === 0) {
      return EMPTY_WORKSPACE_ITEMS;
    }
    return allWorkspaceItems.filter((workspace) => matchesQuery(workspace.searchText, query));
  }, [allWorkspaceItems, open, query]);

  const agentResults = useMemo(() => {
    if (!open || agents.length === 0) {
      return EMPTY_AGENT_ITEMS;
    }
    const items = agents.map<CommandCenterAgentItem>((agent) => {
      const title = agent.title || t("shell.commandCenter.newAgent");
      const workspaceTitle = agent.workspaceId
        ? workspaceTitleByKey.get(`${agent.serverId}:${agent.workspaceId}`)
        : undefined;
      const location = workspaceTitle ?? shortenPath(agent.cwd);
      const subtitle = [
        showAgentHost ? agent.serverLabel : null,
        location,
        formatTimeAgo(agent.lastActivityAt),
      ]
        .filter((part): part is string => Boolean(part))
        .join(" · ");
      return {
        kind: "agent",
        agent,
        title,
        subtitle,
        searchText: buildSearchText(title, subtitle, agent.cwd),
      };
    });
    const filtered = items.filter((item) => matchesQuery(item.searchText, query));
    filtered.sort((left, right) => sortAgents(left.agent, right.agent));
    return filtered;
  }, [agents, open, query, showAgentHost, t, workspaceTitleByKey]);

  const settingsRoute = useMemo<Href>(() => {
    return buildSettingsRoute();
  }, []);

  const homeRoute = useMemo<Href>(() => buildOpenProjectRoute() as Href, []);

  const actionItems = useMemo(() => {
    if (!open) {
      return EMPTY_ACTION_ITEMS;
    }
    return COMMAND_CENTER_ACTIONS.filter(
      (action) => action.routeKind !== "home" || Boolean(homeRoute),
    )
      .map<CommandCenterActionItem>((action) => {
        let route: Href | undefined;
        if (action.routeKind === "settings") route = settingsRoute;
        else if (action.routeKind === "home") route = homeRoute;
        const title = t(action.titleKey);
        return {
          kind: "action",
          id: action.id,
          title,
          icon: action.icon,
          route,
          shortcutKeys: resolveActionShortcutKeys(action.actionId, overrides),
          searchText: buildSearchText(title, ...action.keywords),
        };
      })
      .filter((action) => matchesQuery(action.searchText, query));
  }, [open, query, settingsRoute, homeRoute, overrides, t]);

  const items = useMemo(() => {
    if (!open) {
      return EMPTY_COMMAND_CENTER_ITEMS;
    }
    return [...actionItems, ...workspaceResults, ...agentResults];
  }, [actionItems, workspaceResults, agentResults, open]);

  const handleClose = useCallback(() => {
    setOpen(false);
  }, [setOpen]);

  const handleSelectAgent = useCallback(
    (agent: AggregatedAgent) => {
      didNavigateRef.current = true;

      // Don't restore focus back to the prior element after we navigate.
      clearCommandCenterFocusRestoreElement();
      setOpen(false);
      navigateToAgent({
        serverId: agent.serverId,
        agentId: agent.id,
      });
    },
    [setOpen],
  );

  const handleSelectWorkspace = useCallback(
    (workspace: CommandCenterWorkspaceItem) => {
      didNavigateRef.current = true;
      clearCommandCenterFocusRestoreElement();
      setOpen(false);
      navigateToWorkspace({
        serverId: workspace.serverId,
        workspaceId: workspace.workspaceId,
      });
    },
    [setOpen],
  );

  const handleSelectAction = useCallback(
    (action: CommandCenterActionItem) => {
      if (action.id === "new-agent") {
        openAddProjectFlow();
        return;
      }
      clearCommandCenterFocusRestoreElement();
      setOpen(false);
      if (!action.route) {
        return;
      }
      didNavigateRef.current = true;
      router.push(action.route);
    },
    [openAddProjectFlow, setOpen],
  );

  const handleSelectItem = useCallback(
    (item: CommandCenterItem) => {
      if (item.kind === "action") {
        handleSelectAction(item);
        return;
      }
      if (item.kind === "workspace") {
        handleSelectWorkspace(item);
        return;
      }
      handleSelectAgent(item.agent);
    },
    [handleSelectAction, handleSelectAgent, handleSelectWorkspace],
  );

  useEffect(() => {
    activeIndexRef.current = activeIndex;
  }, [activeIndex]);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => {
    handleCloseRef.current = handleClose;
  }, [handleClose]);

  useEffect(() => {
    handleSelectItemRef.current = handleSelectItem;
  }, [handleSelectItem]);

  useEffect(() => {
    const prevOpen = prevOpenRef.current;
    prevOpenRef.current = open;

    if (!open) {
      closeAddProjectFlow();
      setQuery("");
      setActiveIndex(0);

      if (prevOpen && !didNavigateRef.current) {
        const el = takeCommandCenterFocusRestoreElement();
        const isFocused = () =>
          Boolean(el) && typeof document !== "undefined" && document.activeElement === el;

        const cancel = focusWithRetries({
          focus: () => el?.focus(),
          isFocused,
          onTimeout: () => {
            keyboardActionDispatcher.dispatch({
              id: "message-input.focus",
              scope: "message-input",
            });
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
  }, [closeAddProjectFlow, open]);

  useEffect(() => {
    if (!open) return;
    if (activeIndex >= items.length) {
      setActiveIndex(items.length > 0 ? items.length - 1 : 0);
    }
  }, [activeIndex, items.length, open]);

  const handleKeyEvent = useCallback(
    (key: string): boolean => {
      if (!open || addProjectRequest) return false;
      const currentItems = itemsRef.current;

      if (key === "Escape") {
        handleCloseRef.current();
        return true;
      }

      if (key === "Enter") {
        if (currentItems.length === 0) return false;
        const index = Math.max(0, Math.min(activeIndexRef.current, currentItems.length - 1));
        handleSelectItemRef.current(currentItems[index]);
        return true;
      }

      if (key === "ArrowDown" || key === "ArrowUp") {
        if (currentItems.length === 0) return false;
        setActiveIndex((current) => {
          const delta = key === "ArrowDown" ? 1 : -1;
          const next = current + delta;
          if (next < 0) return currentItems.length - 1;
          if (next >= currentItems.length) return 0;
          return next;
        });
        return true;
      }

      return false;
    },
    [addProjectRequest, open],
  );

  useEffect(() => {
    if (!open || addProjectRequest || !isWeb) return;

    const handler = (event: KeyboardEvent) => {
      if (
        event.key !== "ArrowDown" &&
        event.key !== "ArrowUp" &&
        event.key !== "Enter" &&
        event.key !== "Escape"
      ) {
        return;
      }
      if (handleKeyEvent(event.key)) {
        event.preventDefault();
      }
    };

    // react-native-web can stop propagation on key events, so listen in capture phase.
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [addProjectRequest, open, handleKeyEvent]);

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
    handleKeyEvent,
  };
}

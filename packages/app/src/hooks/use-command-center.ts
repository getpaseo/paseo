import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TextInput } from "react-native";
import { router, usePathname, type Href } from "expo-router";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { keyboardActionDispatcher } from "@/keyboard/keyboard-action-dispatcher";
import { useHosts, useHostRuntimeClient } from "@/runtime/host-runtime";
import { useAllAgentsList } from "@/hooks/use-all-agents-list";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { useOpenProjectPicker } from "@/hooks/use-open-project-picker";
import {
  useSidebarWorkspacesList,
  type SidebarProjectEntry,
  type SidebarWorkspaceEntry,
} from "@/hooks/use-sidebar-workspaces-list";
import {
  clearCommandCenterFocusRestoreElement,
  takeCommandCenterFocusRestoreElement,
} from "@/utils/command-center-focus-restore";
import {
  buildHostSettingsRoute,
  buildHostWorkspaceRoute,
  parseServerIdFromPathname,
} from "@/utils/host-routes";
import type { ShortcutKey } from "@/utils/format-shortcut";
import { chordStringToShortcutKeys } from "@/keyboard/shortcut-string";
import { getBindingIdForAction, getDefaultKeysForAction } from "@/keyboard/keyboard-shortcuts";
import { useKeyboardShortcutOverrides } from "@/hooks/use-keyboard-shortcut-overrides";
import { getShortcutOs } from "@/utils/shortcut-platform";
import { getIsElectronRuntime } from "@/constants/layout";
import { prepareWorkspaceTab } from "@/utils/workspace-navigation";
import { focusWithRetries } from "@/utils/web-focus";

const EMPTY_AGENTS: AggregatedAgent[] = [];
const EMPTY_ACTION_ITEMS: CommandCenterActionItem[] = [];
const EMPTY_COMMAND_CENTER_ITEMS: CommandCenterItem[] = [];

function isMatch(agent: AggregatedAgent, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const title = (agent.title ?? "New agent").toLowerCase();
  const cwd = agent.cwd.toLowerCase();
  return title.includes(q) || cwd.includes(q);
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

type CommandCenterActionDefinition = {
  id: string;
  title: string;
  icon?: "plus" | "settings";
  actionId?: string;
  keywords: string[];
  routeKind: "settings" | "none";
};

const COMMAND_CENTER_ACTIONS: readonly CommandCenterActionDefinition[] = [
  {
    id: "new-agent",
    title: "Open project",
    icon: "plus",
    actionId: "new-agent",
    keywords: ["open", "project", "folder", "workspace", "repo"],
    routeKind: "none",
  },
  {
    id: "settings",
    title: "Settings",
    icon: "settings",
    keywords: ["settings", "preferences", "config", "configuration"],
    routeKind: "settings",
  },
];

function matchesActionQuery(query: string, action: CommandCenterActionDefinition): boolean {
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
  route?: Href;
  shortcutKeys?: ShortcutKey[][];
};

export interface CommandCenterFile {
  workspaceId: string;
  workspaceName?: string;
  relativePath: string;
}

export type CommandCenterItem =
  | {
      kind: "action";
      action: CommandCenterActionItem;
    }
  | {
      kind: "agent";
      agent: AggregatedAgent;
    }
  | {
      kind: "project";
      project: SidebarProjectEntry;
    }
  | {
      kind: "workspace";
      workspace: SidebarWorkspaceEntry;
      projectName: string;
    }
  | {
      kind: "file";
      file: CommandCenterFile;
    };

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
  const pathname = usePathname();
  const daemons = useHosts();
  const { overrides } = useKeyboardShortcutOverrides();
  const open = useKeyboardShortcutsStore((s) => s.commandCenterOpen);
  const setOpen = useKeyboardShortcutsStore((s) => s.setCommandCenterOpen);
  const inputRef = useRef<TextInput>(null);
  const didNavigateRef = useRef(false);
  const prevOpenRef = useRef(open);
  const activeIndexRef = useRef(0);
  const itemsRef = useRef<CommandCenterItem[]>([]);
  const handleCloseRef = useRef<() => void>(() => undefined);
  const handleSelectItemRef = useRef<(item: CommandCenterItem) => void>(() => undefined);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const activeServerId = useMemo(() => {
    if (!open) {
      return null;
    }
    const serverIdFromPath = parseServerIdFromPathname(pathname);
    if (serverIdFromPath) {
      const routeMatch = daemons.find((entry) => entry.serverId === serverIdFromPath);
      if (routeMatch) {
        return routeMatch.serverId;
      }
    }
    return daemons[0]?.serverId ?? null;
  }, [daemons, open, pathname]);

  const { agents } = useAllAgentsList({
    serverId: activeServerId,
  });

  const { projects: sidebarProjects } = useSidebarWorkspacesList({
    serverId: activeServerId,
  });

  const daemonClient = useHostRuntimeClient(activeServerId ?? "");
  const [fileResults, setFileResults] = useState<CommandCenterFile[]>([]);
  // Debounce file search so we don't hammer the daemon on every keystroke.
  useEffect(() => {
    if (!open) {
      setFileResults([]);
      return;
    }
    const trimmed = query.trim();
    if (trimmed.length < 2 || !daemonClient) {
      setFileResults([]);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(() => {
      daemonClient
        .searchFiles({ query: trimmed, limit: 25 })
        .then((res) => {
          if (cancelled) return;
          setFileResults(
            res.results.map((r) => ({
              workspaceId: r.workspaceId,
              workspaceName: r.workspaceName,
              relativePath: r.relativePath,
            })),
          );
        })
        .catch(() => {
          if (!cancelled) setFileResults([]);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [daemonClient, open, query]);

  const agentResults = useMemo(() => {
    if (!open || agents.length === 0) {
      return EMPTY_AGENTS;
    }
    const filtered = agents.filter((agent) => isMatch(agent, query));
    filtered.sort(sortAgents);
    return filtered;
  }, [agents, open, query]);

  const settingsRoute = useMemo<Href>(() => {
    const serverIdFromPath = activeServerId;
    return serverIdFromPath ? buildHostSettingsRoute(serverIdFromPath) : "/";
  }, [activeServerId]);

  const actionItems = useMemo(() => {
    if (!open) {
      return EMPTY_ACTION_ITEMS;
    }
    return COMMAND_CENTER_ACTIONS.filter((action) =>
      matchesActionQuery(query, action),
    ).map<CommandCenterActionItem>((action) => ({
      kind: "action",
      id: action.id,
      title: action.title,
      icon: action.icon,
      route: action.routeKind === "settings" ? settingsRoute : undefined,
      shortcutKeys: resolveActionShortcutKeys(action.actionId, overrides),
    }));
  }, [open, query, settingsRoute, overrides]);

  const projectResults = useMemo(() => {
    if (!open) return [] as SidebarProjectEntry[];
    const q = query.trim().toLowerCase();
    if (!q) return sidebarProjects;
    return sidebarProjects.filter((p) => p.projectName.toLowerCase().includes(q));
  }, [open, query, sidebarProjects]);

  const workspaceResults = useMemo(() => {
    if (!open) return [] as Array<{ workspace: SidebarWorkspaceEntry; projectName: string }>;
    const q = query.trim().toLowerCase();
    const out: Array<{ workspace: SidebarWorkspaceEntry; projectName: string }> = [];
    for (const project of sidebarProjects) {
      for (const workspace of project.workspaces) {
        if (q && !workspace.name.toLowerCase().includes(q)) continue;
        out.push({ workspace, projectName: project.projectName });
      }
    }
    return out;
  }, [open, query, sidebarProjects]);

  const items = useMemo(() => {
    if (!open) {
      return EMPTY_COMMAND_CENTER_ITEMS;
    }
    const next: CommandCenterItem[] = [];
    for (const action of actionItems) {
      next.push({ kind: "action", action });
    }
    for (const project of projectResults) {
      next.push({ kind: "project", project });
    }
    for (const { workspace, projectName } of workspaceResults) {
      next.push({ kind: "workspace", workspace, projectName });
    }
    for (const agent of agentResults) {
      next.push({ kind: "agent", agent });
    }
    for (const file of fileResults) {
      next.push({ kind: "file", file });
    }
    return next;
  }, [actionItems, projectResults, workspaceResults, agentResults, fileResults, open]);

  const handleClose = useCallback(() => {
    setOpen(false);
  }, [setOpen]);

  const handleSelectAgent = useCallback(
    (agent: AggregatedAgent) => {
      didNavigateRef.current = true;

      // Don't restore focus back to the prior element after we navigate.
      clearCommandCenterFocusRestoreElement();
      setOpen(false);
      const route = prepareWorkspaceTab({
        serverId: agent.serverId,
        workspaceId: agent.cwd,
        target: { kind: "agent", agentId: agent.id },
      });
      router.navigate(route);
    },
    [setOpen],
  );

  const openProjectPicker = useOpenProjectPicker(activeServerId);

  const handleSelectAction = useCallback(
    (action: CommandCenterActionItem) => {
      clearCommandCenterFocusRestoreElement();
      setOpen(false);
      if (action.id === "new-agent") {
        void openProjectPicker();
        return;
      }
      if (!action.route) {
        return;
      }
      didNavigateRef.current = true;
      router.push(action.route);
    },
    [openProjectPicker, setOpen],
  );

  const handleSelectWorkspace = useCallback(
    (workspace: SidebarWorkspaceEntry) => {
      didNavigateRef.current = true;
      clearCommandCenterFocusRestoreElement();
      setOpen(false);
      router.navigate(buildHostWorkspaceRoute(workspace.serverId, workspace.workspaceId));
    },
    [setOpen],
  );

  const handleSelectProject = useCallback(
    (project: SidebarProjectEntry) => {
      // Jump into the project's first workspace — the sidebar list already
      // sorts by "most relevant" so taking `[0]` matches the sidebar click.
      const first = project.workspaces[0];
      if (!first) return;
      handleSelectWorkspace(first);
    },
    [handleSelectWorkspace],
  );

  const handleSelectFile = useCallback(
    (file: CommandCenterFile) => {
      if (!activeServerId) return;
      didNavigateRef.current = true;
      clearCommandCenterFocusRestoreElement();
      setOpen(false);
      // Nav to the file tab inside its workspace. `prepareWorkspaceTab`
      // opens the file in the editor pane next to any existing tabs.
      router.navigate(
        prepareWorkspaceTab({
          serverId: activeServerId,
          workspaceId: file.workspaceId,
          target: { kind: "file", path: file.relativePath },
        }),
      );
    },
    [activeServerId, setOpen],
  );

  const handleSelectItem = useCallback(
    (item: CommandCenterItem) => {
      if (item.kind === "action") {
        handleSelectAction(item.action);
        return;
      }
      if (item.kind === "project") {
        handleSelectProject(item.project);
        return;
      }
      if (item.kind === "workspace") {
        handleSelectWorkspace(item.workspace);
        return;
      }
      if (item.kind === "file") {
        handleSelectFile(item.file);
        return;
      }
      handleSelectAgent(item.agent);
    },
    [
      handleSelectAction,
      handleSelectAgent,
      handleSelectFile,
      handleSelectProject,
      handleSelectWorkspace,
    ],
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
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (activeIndex >= items.length) {
      setActiveIndex(items.length > 0 ? items.length - 1 : 0);
    }
  }, [activeIndex, items.length, open]);

  useEffect(() => {
    if (!open) return;

    const handler = (event: KeyboardEvent) => {
      const currentItems = itemsRef.current;
      const key = event.key;
      if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Enter" && key !== "Escape") {
        return;
      }

      if (key === "Escape") {
        event.preventDefault();
        handleCloseRef.current();
        return;
      }

      if (key === "Enter") {
        if (currentItems.length === 0) return;
        event.preventDefault();
        const index = Math.max(0, Math.min(activeIndexRef.current, currentItems.length - 1));
        handleSelectItemRef.current(currentItems[index]!);
        return;
      }

      if (key === "ArrowDown" || key === "ArrowUp") {
        if (currentItems.length === 0) return;
        event.preventDefault();
        setActiveIndex((current) => {
          const delta = key === "ArrowDown" ? 1 : -1;
          const next = current + delta;
          if (next < 0) return currentItems.length - 1;
          if (next >= currentItems.length) return 0;
          return next;
        });
      }
    };

    // react-native-web can stop propagation on key events, so listen in capture phase.
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [open]);

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

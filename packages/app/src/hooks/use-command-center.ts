import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TextInput } from "react-native";
import { router, type Href } from "expo-router";
import { useTranslation } from "react-i18next";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { keyboardActionDispatcher } from "@/keyboard/keyboard-action-dispatcher";
import { useAggregatedAgents, type AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { useOpenAddProject } from "@/hooks/use-open-add-project";
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
import {
  navigateToWorkspace,
  useLastWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import type {
  AgentModelDefinition,
  AgentProvider,
  ProviderSnapshotEntry,
} from "@getpaseo/protocol/agent-types";
import { useSessionStore } from "@/stores/session-store";
import {
  useFocusedDraftControllerStore,
  type FocusedDraftController,
} from "@/stores/focused-draft-controller-store";
import { useShallow } from "zustand/shallow";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { resolveAgentModelSelection } from "@/composer/agent-controls/utils";
import { mergeProviderPreferences, useFormPreferences } from "@/hooks/use-form-preferences";
import { useToast } from "@/contexts/toast-context";
import { toErrorMessage } from "@/utils/error-messages";
import { formatTimeAgo } from "@/utils/time";
import { shortenPath } from "@/utils/shorten-path";

const EMPTY_ACTION_ITEMS: CommandCenterActionItem[] = [];
const EMPTY_WORKSPACE_ITEMS: CommandCenterWorkspaceItem[] = [];
const EMPTY_AGENT_ITEMS: CommandCenterAgentItem[] = [];
const EMPTY_MODEL_ITEMS: CommandCenterModelItem[] = [];
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

export interface CommandCenterModelItem {
  kind: "model";
  /** "agent": switch a running agent's model. "draft": pick provider+model for a new tab. */
  source: "agent" | "draft";
  serverId: string;
  /** Present for the "agent" source; null for a draft (handled via the focused-draft store). */
  agentId: string | null;
  provider: AgentProvider;
  modelId: string;
  /** Breadcrumb top segment shown muted, e.g. "Model". */
  groupLabel: string;
  /** Breadcrumb middle segment shown muted, e.g. "Claude". */
  providerLabel: string;
  /** Breadcrumb leaf (the model label), highlighted, e.g. "Opus 4.8". */
  title: string;
  isActive: boolean;
  searchText: string;
}

export type CommandCenterItem =
  | CommandCenterActionItem
  | CommandCenterWorkspaceItem
  | CommandCenterAgentItem
  | CommandCenterModelItem;

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

interface ModelRowContext {
  serverId: string;
  groupLabel: string;
  keywords: string;
}

function buildModelItem(
  ctx: ModelRowContext,
  input: {
    source: "agent" | "draft";
    agentId: string | null;
    provider: AgentProvider;
    providerLabel: string;
    model: AgentModelDefinition;
    isActive: boolean;
  },
): CommandCenterModelItem {
  return {
    kind: "model",
    source: input.source,
    serverId: ctx.serverId,
    agentId: input.agentId,
    provider: input.provider,
    modelId: input.model.id,
    groupLabel: ctx.groupLabel,
    providerLabel: input.providerLabel,
    title: input.model.label,
    isActive: input.isActive,
    searchText: buildSearchText(
      ctx.groupLabel,
      input.providerLabel,
      input.model.label,
      input.model.id,
      ctx.keywords,
    ),
  };
}

interface ModelAgentSlice {
  provider: AgentProvider;
  runtimeModelId: string | null;
  model: string | null;
  thinkingOptionId: string | null | undefined;
}

// Running agent: only its own provider's models (a live agent can't change provider).
function buildAgentModelRows(
  ctx: ModelRowContext,
  input: { agentId: string; slice: ModelAgentSlice; entries: ProviderSnapshotEntry[] | undefined },
): CommandCenterModelItem[] {
  const entry = input.entries?.find((e) => e.provider === input.slice.provider) ?? null;
  const models = entry?.models ?? null;
  if (!models || models.length === 0) return [];
  const providerLabel = entry?.label ?? input.slice.provider;
  const { activeModelId } = resolveAgentModelSelection({
    models,
    runtimeModelId: input.slice.runtimeModelId,
    configuredModelId: input.slice.model,
    explicitThinkingOptionId: input.slice.thinkingOptionId,
  });
  return models.map((model) =>
    buildModelItem(ctx, {
      source: "agent",
      agentId: input.agentId,
      provider: input.slice.provider,
      providerLabel,
      model,
      isActive: model.id === activeModelId,
    }),
  );
}

// New draft tab: every available provider's models flattened into one list.
function buildDraftModelRows(
  ctx: ModelRowContext,
  input: { draft: FocusedDraftController; entries: ProviderSnapshotEntry[] | undefined },
): CommandCenterModelItem[] {
  const rows: CommandCenterModelItem[] = [];
  for (const entry of input.entries ?? []) {
    const models = entry.models ?? [];
    if (models.length === 0) continue;
    const providerLabel = entry.label ?? entry.provider;
    for (const model of models) {
      rows.push(
        buildModelItem(ctx, {
          source: "draft",
          agentId: null,
          provider: entry.provider,
          providerLabel,
          model,
          isActive:
            input.draft.provider === entry.provider && input.draft.selectedModelId === model.id,
        }),
      );
    }
  }
  return rows;
}

export function useCommandCenter() {
  const { t } = useTranslation();
  const { overrides } = useKeyboardShortcutOverrides();
  const open = useKeyboardShortcutsStore((s) => s.commandCenterOpen);
  const setOpen = useKeyboardShortcutsStore((s) => s.setCommandCenterOpen);
  const openAddProject = useOpenAddProject();
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

  const toast = useToast();
  const { updatePreferences } = useFormPreferences();

  // Active agent (the focused pane's agent of the active workspace). Read from global
  // zustand singletons — SessionContext is not an ancestor of the CommandCenter.
  const activeSelection = useLastWorkspaceSelection();
  const activeServerId = activeSelection?.serverId ?? null;
  const activeAgentId = useSessionStore((state) =>
    activeServerId ? (state.sessions[activeServerId]?.focusedAgentId ?? null) : null,
  );
  const activeClient = useSessionStore((state) =>
    activeServerId ? (state.sessions[activeServerId]?.client ?? null) : null,
  );
  const activeAgentSlice = useSessionStore(
    useShallow((state) => {
      if (!activeServerId || !activeAgentId) return null;
      const agent = state.sessions[activeServerId]?.agents?.get(activeAgentId);
      if (!agent) return null;
      return {
        provider: agent.provider,
        cwd: agent.cwd,
        runtimeModelId: agent.runtimeInfo?.model ?? null,
        model: agent.model,
        thinkingOptionId: agent.thinkingOptionId,
      };
    }),
  );

  // A running agent takes priority; otherwise a focused draft (new tab) contributes the
  // "pick provider + model" list. The draft publishes its controller globally (see store).
  const draftController = useFocusedDraftControllerStore((state) => state.controller);
  const isAgentFocus = Boolean(activeAgentId && activeAgentSlice);
  const draftFocus = !isAgentFocus ? draftController : null;

  const modelServerId = isAgentFocus ? activeServerId : (draftFocus?.serverId ?? null);
  const modelCwd = isAgentFocus ? activeAgentSlice?.cwd : draftFocus?.cwd;
  const { entries: snapshotEntries } = useProvidersSnapshot(modelServerId, {
    cwd: modelCwd,
    enabled: open && Boolean(modelServerId && (isAgentFocus || draftFocus)),
  });

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

  const modelResults = useMemo(() => {
    // Only surface models once the user starts typing — keeps the default view clean.
    if (!open || !query.trim() || !modelServerId) {
      return EMPTY_MODEL_ITEMS;
    }
    const ctx: ModelRowContext = {
      serverId: modelServerId,
      groupLabel: t("shell.commandCenter.modelGroupLabel"),
      keywords: t("shell.commandCenter.modelSearchKeywords"),
    };
    let rows: CommandCenterModelItem[];
    if (isAgentFocus && activeAgentId && activeAgentSlice) {
      rows = buildAgentModelRows(ctx, {
        agentId: activeAgentId,
        slice: activeAgentSlice,
        entries: snapshotEntries,
      });
    } else if (draftFocus) {
      rows = buildDraftModelRows(ctx, { draft: draftFocus, entries: snapshotEntries });
    } else {
      rows = [];
    }
    return rows.filter((item) => matchesQuery(item.searchText, query));
  }, [
    open,
    query,
    modelServerId,
    isAgentFocus,
    activeAgentId,
    activeAgentSlice,
    draftFocus,
    snapshotEntries,
    t,
  ]);

  const items = useMemo(() => {
    if (!open) {
      return EMPTY_COMMAND_CENTER_ITEMS;
    }
    return [...actionItems, ...modelResults, ...workspaceResults, ...agentResults];
  }, [actionItems, modelResults, workspaceResults, agentResults, open]);

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
      clearCommandCenterFocusRestoreElement();
      setOpen(false);
      if (action.id === "new-agent") {
        openAddProject();
        return;
      }
      if (!action.route) {
        return;
      }
      didNavigateRef.current = true;
      router.push(action.route);
    },
    [openAddProject, setOpen],
  );

  const handleSelectModel = useCallback(
    (item: CommandCenterModelItem) => {
      // Switching a model does not navigate — keep the focus-restore behavior so focus
      // returns to the previously focused element after the palette closes.
      setOpen(false);
      if (item.source === "draft") {
        // Write the choice into the focused draft's live form (sets provider + model).
        useFocusedDraftControllerStore
          .getState()
          .controller?.setProviderAndModel(item.provider, item.modelId);
        return;
      }
      if (item.isActive || !activeClient || !item.agentId) {
        return;
      }
      void updatePreferences((current) =>
        mergeProviderPreferences({
          preferences: current,
          provider: item.provider,
          updates: { model: item.modelId },
        }),
      ).catch((error) => {
        console.warn("[CommandCenter] persist model preference failed", error);
      });
      void activeClient.setAgentModel(item.agentId, item.modelId).catch((error) => {
        console.warn("[CommandCenter] setAgentModel failed", error);
        toast.error(toErrorMessage(error));
      });
    },
    [activeClient, setOpen, toast, updatePreferences],
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
      if (item.kind === "model") {
        handleSelectModel(item);
        return;
      }
      handleSelectAgent(item.agent);
    },
    [handleSelectAction, handleSelectAgent, handleSelectWorkspace, handleSelectModel],
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

  const handleKeyEvent = useCallback(
    (key: string): boolean => {
      if (!open) return false;
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
    [open],
  );

  useEffect(() => {
    if (!open || !isWeb) return;

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
  }, [open, handleKeyEvent]);

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

import { useCallback, useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { AutocompleteOption } from "@/components/ui/autocomplete";
import {
  useAgentCommandsQuery,
  type AgentSlashCommand,
  type DraftCommandConfig,
} from "./use-agent-commands-query";
import { orderAutocompleteOptions } from "@/components/ui/autocomplete-utils";
import { useAutocomplete } from "./use-autocomplete";
import { useAgentHistory } from "./use-agent-history";
import type { AggregatedAgent } from "./use-aggregated-agents";
import { useSessionStore } from "@/stores/session-store";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { CLIENT_SLASH_COMMANDS, type ClientSlashCommand } from "@/client-slash-commands";
import {
  applySlashCommandReplacement,
  filterAndRankCommandAutocompleteEntries,
  filterInlineSkillCommandEntries,
  findActiveSlashCommand,
  type SlashCommandRange,
} from "@/utils/agent-command-autocomplete";
import {
  applyAgentMentionReplacement,
  applyFileMentionReplacement,
  filterAndRankAgentMentionCandidates,
  findActiveFileMention,
  type FileMentionRange,
} from "@/utils/file-mention-autocomplete";

export interface AgentMentionSelection {
  serverId: string;
  agentId: string;
  title: string;
  provider: AggregatedAgent["provider"];
  workspaceLabel?: string;
}

export const MAX_AGENT_MENTION_SUGGESTIONS = 30;

interface UseAgentAutocompleteInput {
  userInput: string;
  cursorIndex: number;
  setUserInput: (nextValue: string) => void;
  serverId: string;
  agentId: string;
  draftConfig?: DraftCommandConfig;
  onAutocompleteApplied?: () => void;
  /** Return false to keep the @ query visible (for example, when the attachment limit is full). */
  onSelectAgent?: (agent: AgentMentionSelection) => boolean | void;
  onClientSlashCommand?: (command: ClientSlashCommand) => void;
  canExecuteClientSlashCommand?: boolean;
}

interface AgentAutocompleteKeyPressEvent {
  key: string;
  preventDefault: () => void;
  input: AgentAutocompleteInputSnapshot;
}

interface AgentAutocompleteInputSnapshot {
  text: string;
  selection: { start: number; end: number };
}

type AgentAutocompleteOption =
  | (AutocompleteOption & { type: "client_command"; command: ClientSlashCommand })
  | (AutocompleteOption & { type: "provider_command" })
  | (AutocompleteOption & {
      type: "workspace_entry";
      entryPath: string;
      mention: FileMentionRange;
    })
  | (AutocompleteOption & {
      type: "agent";
      agent: AgentMentionSelection;
      mention: FileMentionRange;
    });

interface AgentAutocompleteResult {
  isVisible: boolean;
  options: AutocompleteOption[];
  selectedIndex: number;
  isLoading: boolean;
  errorMessage?: string;
  loadingText: string;
  emptyText: string;
  onSelectOption: (option: AutocompleteOption, input?: AgentAutocompleteInputSnapshot) => void;
  onKeyPress: (event: AgentAutocompleteKeyPressEvent) => boolean;
}

interface AgentAutocompleteSnapshot {
  text: string;
  slashCommand: SlashCommandRange | null;
  fileMention: FileMentionRange | null;
}

function resolveAgentAutocompleteSnapshot(input: {
  input?: AgentAutocompleteInputSnapshot;
  userInput: string;
  cursorIndex: number;
  activeSlashCommand: SlashCommandRange | null;
  activeFileMention: FileMentionRange | null;
}): AgentAutocompleteSnapshot {
  if (!input.input) {
    return {
      text: input.userInput,
      slashCommand: input.activeSlashCommand,
      fileMention: input.activeFileMention,
    };
  }

  const text = input.input.text;
  const cursorIndex = input.input.selection.start;
  return {
    text,
    slashCommand: findActiveSlashCommand({ text, cursorIndex }),
    fileMention: findActiveFileMention({ text, cursorIndex }),
  };
}

export interface DirectorySuggestionEntry {
  path: string;
  kind: "file" | "directory";
}

type AvailableCommand =
  | { source: "client"; command: ClientSlashCommand }
  | { source: "provider"; command: AgentSlashCommand };

function normalizeDraftCommandConfig(
  draftConfig?: DraftCommandConfig,
): DraftCommandConfig | undefined {
  if (!draftConfig) {
    return undefined;
  }

  const cwd = draftConfig.cwd.trim();
  if (!cwd) {
    return undefined;
  }

  const modeId = draftConfig.modeId?.trim() ?? "";
  const model = draftConfig.model?.trim() ?? "";
  const thinkingOptionId = draftConfig.thinkingOptionId?.trim() ?? "";
  const featureValues = draftConfig.featureValues;
  return {
    provider: draftConfig.provider,
    cwd,
    ...(modeId ? { modeId } : {}),
    ...(model ? { model } : {}),
    ...(thinkingOptionId ? { thinkingOptionId } : {}),
    ...(featureValues && Object.keys(featureValues).length > 0 ? { featureValues } : {}),
  };
}

function mapDirectorySuggestionsToEntries(payload: {
  entries?: Array<{ path: string; kind: string }>;
  directories?: string[];
}): DirectorySuggestionEntry[] {
  if (Array.isArray(payload.entries) && payload.entries.length > 0) {
    return payload.entries.flatMap((entry) => {
      if (
        !entry ||
        typeof entry.path !== "string" ||
        (entry.kind !== "file" && entry.kind !== "directory")
      ) {
        return [];
      }
      return [{ path: entry.path, kind: entry.kind }];
    });
  }

  return (payload.directories ?? []).map((path) => ({
    path,
    kind: "directory" as const,
  }));
}

function mapCommandToOption(entry: AvailableCommand, t: TFunction): AgentAutocompleteOption {
  const command = entry.command;
  const base = {
    id: command.name,
    label: `/${command.name}`,
    detail: command.argumentHint || undefined,
    description:
      entry.source === "client" ? t(entry.command.descriptionKey) : entry.command.description,
    kind: "command" as const,
  };
  if (entry.source === "client") {
    return {
      ...base,
      type: "client_command",
      command: entry.command,
    };
  }
  return {
    ...base,
    type: "provider_command",
  };
}

function resolveAgentMentionTitle(agent: AggregatedAgent): string {
  const title = agent.title?.trim();
  return title || agent.id;
}

function toAgentMentionSelection(agent: AggregatedAgent): AgentMentionSelection {
  const selection: AgentMentionSelection = {
    serverId: agent.serverId,
    agentId: agent.id,
    title: resolveAgentMentionTitle(agent),
    provider: agent.provider,
  };
  const workspaceLabel = agent.projectPlacement?.workspaceName?.trim() || agent.cwd.trim();
  if (workspaceLabel) {
    selection.workspaceLabel = workspaceLabel;
  }
  return selection;
}

export type AutocompleteMode = "command" | "file" | null;

export interface BuildAutocompleteOptionsInput {
  isVisible: boolean;
  mode: AutocompleteMode;
  commands: AgentSlashCommand[];
  isDraftContext: boolean;
  commandFilterQuery: string;
  activeSlashCommand: SlashCommandRange | null;
  activeFileMention: FileMentionRange | null;
  fileSuggestions: DirectorySuggestionEntry[];
  agentSuggestions: AgentMentionSelection[];
  t: TFunction;
}

export function buildCommandAutocompleteOptions(input: BuildAutocompleteOptionsInput) {
  if (!input.isVisible) {
    return [];
  }

  if (input.mode === "command") {
    const providerCommands = input.commands.map(
      (command): AvailableCommand => ({ source: "provider", command }),
    );
    const clientCommandNames = new Set(CLIENT_SLASH_COMMANDS.map((command) => command.name));
    const rootCommands: AvailableCommand[] = input.isDraftContext
      ? providerCommands
      : [
          ...CLIENT_SLASH_COMMANDS.map(
            (command): AvailableCommand => ({ source: "client", command }),
          ),
          ...providerCommands.filter((entry) => !clientCommandNames.has(entry.command.name)),
        ];
    const availableCommands =
      input.activeSlashCommand?.position === "inline"
        ? filterInlineSkillCommandEntries(providerCommands)
        : rootCommands;
    const matches = filterAndRankCommandAutocompleteEntries(
      availableCommands,
      input.commandFilterQuery,
    );
    const orderedMatches = orderAutocompleteOptions(matches);
    return orderedMatches.map((entry) => mapCommandToOption(entry, input.t));
  }

  const activeFileMention = input.activeFileMention;
  if (input.mode === "file" && activeFileMention) {
    const agentSection = {
      id: "agents",
      label: input.t("agentAutocomplete.agents"),
    };
    const workspaceSection = {
      id: "workspace",
      label: input.t("agentAutocomplete.filesAndFolders"),
    };
    const logicalOptions: AgentAutocompleteOption[] = [
      ...input.agentSuggestions.map((agent) => ({
        type: "agent" as const,
        id: `agent:${agent.serverId}:${agent.agentId}`,
        label: agent.title,
        description:
          [agent.workspaceLabel, agent.provider].filter(Boolean).join(" · ") ||
          input.t("agentAutocomplete.agent"),
        kind: "agent" as const,
        section: agentSection,
        agent,
        mention: activeFileMention,
      })),
      ...input.fileSuggestions.map((entry) => ({
        type: "workspace_entry" as const,
        id: `${entry.kind}:${entry.path}`,
        label: entry.path,
        kind: entry.kind,
        section: workspaceSection,
        entryPath: entry.path,
        mention: activeFileMention,
      })),
    ];
    // The popover is anchored above the input, so the list is reversed as one
    // unit. Agents then occupy the visible bottom section and the best agent is
    // the default Enter target, while files remain available immediately above.
    return orderAutocompleteOptions(logicalOptions);
  }

  return [];
}

function resolveAutocompleteMode(args: {
  showFileAutocomplete: boolean;
  showCommandAutocomplete: boolean;
}): AutocompleteMode {
  if (args.showFileAutocomplete) {
    return "file";
  }
  if (args.showCommandAutocomplete) {
    return "command";
  }
  return null;
}

function resolveAutocompleteIsVisible(args: {
  mode: AutocompleteMode;
  canLoadCommands: boolean;
  serverId: string;
  autocompleteCwd: string;
  canSelectAgents: boolean;
}): boolean {
  if (args.mode === "command") {
    return args.canLoadCommands;
  }
  if (args.mode === "file") {
    return Boolean(args.serverId) && (args.autocompleteCwd.length > 0 || args.canSelectAgents);
  }
  return false;
}

function resolveCanLoadCommands(args: {
  serverId: string;
  agentId: string;
  isDraftContext: boolean;
}): boolean {
  if (!args.serverId) {
    return false;
  }
  return Boolean(args.agentId) || args.isDraftContext;
}

function resolveAutocompleteIsLoading(args: {
  mode: AutocompleteMode;
  isCommandsLoading: boolean;
  fileSuggestionsIsPending: boolean;
  fileSuggestionsIsLoading: boolean;
  agentHistoryIsInitialLoad: boolean;
  optionsLength: number;
}): boolean {
  if (args.mode === "command") {
    return args.isCommandsLoading && args.optionsLength === 0;
  }
  if (args.mode === "file") {
    return (
      args.fileSuggestionsIsPending ||
      (args.fileSuggestionsIsLoading && args.optionsLength === 0) ||
      (args.agentHistoryIsInitialLoad && args.optionsLength === 0)
    );
  }
  return false;
}

function resolveAutocompleteErrorMessage(args: {
  mode: AutocompleteMode;
  isCommandError: boolean;
  commandError: Error | null;
  fileSuggestionsError: unknown;
  isAgentHistoryError: boolean;
  optionsLength: number;
  t: TFunction;
}): string | undefined {
  if (args.mode === "command") {
    return args.isCommandError
      ? (args.commandError?.message ?? args.t("agentAutocomplete.failedToLoad"))
      : undefined;
  }
  if (args.mode === "file") {
    if (args.optionsLength > 0) {
      return undefined;
    }
    if (args.fileSuggestionsError instanceof Error) {
      return args.fileSuggestionsError.message;
    }
    if (args.isAgentHistoryError) {
      return args.t("agentAutocomplete.failedToLoad");
    }
  }
  return undefined;
}

function resolveAgentHistoryEnabled(args: {
  mode: AutocompleteMode;
  canSelectAgents: boolean;
  serverId: string;
}): boolean {
  return args.mode === "file" && args.canSelectAgents && Boolean(args.serverId);
}

function resolveFileSuggestionsEnabled(args: {
  mode: AutocompleteMode;
  serverId: string;
  autocompleteCwd: string;
  hasClient: boolean;
  isConnected: boolean;
}): boolean {
  return (
    args.mode === "file" &&
    Boolean(args.serverId) &&
    args.autocompleteCwd.length > 0 &&
    args.hasClient &&
    args.isConnected
  );
}

function resolveFileSuggestionsLoadingState(args: {
  enabled: boolean;
  isPending: boolean;
  isLoading: boolean;
}): { isPending: boolean; isLoading: boolean } {
  return {
    isPending: args.enabled && args.isPending,
    isLoading: args.enabled && args.isLoading,
  };
}

function resolveAutocompleteCopy(args: {
  mode: AutocompleteMode;
  canSelectAgents: boolean;
  t: TFunction;
}): { loadingText: string; emptyText: string } {
  if (args.mode === "file") {
    if (args.canSelectAgents) {
      return {
        loadingText: args.t("agentAutocomplete.searchingMentions"),
        emptyText: args.t("agentAutocomplete.noMentionResults"),
      };
    }
    return {
      loadingText: args.t("agentAutocomplete.searchingWorkspace"),
      emptyText: args.t("agentAutocomplete.noFiles"),
    };
  }
  return {
    loadingText: args.t("agentAutocomplete.loadingCommands"),
    emptyText: args.t("agentAutocomplete.noCommands"),
  };
}

export function useAgentAutocomplete(input: UseAgentAutocompleteInput): AgentAutocompleteResult {
  const { t } = useTranslation();
  const {
    userInput,
    cursorIndex,
    setUserInput,
    serverId,
    agentId,
    draftConfig,
    onAutocompleteApplied,
    onSelectAgent,
    onClientSlashCommand,
    canExecuteClientSlashCommand,
  } = input;

  const activeSlashCommand = useMemo(
    () =>
      findActiveSlashCommand({
        text: userInput,
        cursorIndex,
      }),
    [cursorIndex, userInput],
  );
  const showCommandAutocomplete = activeSlashCommand !== null;
  const commandFilterQuery = activeSlashCommand?.query ?? "";

  const activeFileMention = useMemo(
    () =>
      findActiveFileMention({
        text: userInput,
        cursorIndex,
      }),
    [cursorIndex, userInput],
  );
  const showFileAutocomplete = activeFileMention !== null;
  const fileFilterQuery = activeFileMention?.query ?? "";
  const [debouncedFileFilterQuery, setDebouncedFileFilterQuery] = useState(fileFilterQuery);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedFileFilterQuery(fileFilterQuery), 180);
    return () => clearTimeout(timer);
  }, [fileFilterQuery]);

  const normalizedDraftConfig = useMemo(
    () => normalizeDraftCommandConfig(draftConfig),
    [draftConfig],
  );

  const isDraftContext = normalizedDraftConfig !== undefined;
  const queryDraftConfig = normalizedDraftConfig;
  const canLoadCommands = resolveCanLoadCommands({ serverId, agentId, isDraftContext });

  const agentCwd = useSessionStore(
    (state) => state.sessions[serverId]?.agents?.get(agentId)?.cwd ?? "",
  );
  const autocompleteCwd = useMemo(() => {
    if (isDraftContext) {
      return queryDraftConfig?.cwd ?? "";
    }
    return agentCwd.trim();
  }, [agentCwd, isDraftContext, queryDraftConfig]);

  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);

  const mode = resolveAutocompleteMode({ showFileAutocomplete, showCommandAutocomplete });
  const canSelectAgents = onSelectAgent !== undefined;
  const canShowAutocomplete = resolveAutocompleteIsVisible({
    mode,
    canLoadCommands,
    serverId,
    autocompleteCwd,
    canSelectAgents,
  });

  const {
    commands,
    isLoading: isCommandsLoading,
    isError,
    error,
  } = useAgentCommandsQuery({
    serverId,
    agentId,
    enabled: mode === "command" && canLoadCommands,
    draftConfig: queryDraftConfig,
  });

  const isVisible = canShowAutocomplete && !(mode === "command" && isCommandsLoading);

  const agentHistory = useAgentHistory({
    serverId,
    enabled: resolveAgentHistoryEnabled({ mode, canSelectAgents, serverId }),
  });

  const agentSuggestions = useMemo<AgentMentionSelection[]>(() => {
    if (!canSelectAgents) {
      return [];
    }
    return filterAndRankAgentMentionCandidates(agentHistory.agents, fileFilterQuery, agentId)
      .slice(0, MAX_AGENT_MENTION_SUGGESTIONS)
      .map(toAgentMentionSelection);
  }, [agentHistory.agents, agentId, canSelectAgents, fileFilterQuery]);

  const canLoadFileSuggestions = resolveFileSuggestionsEnabled({
    mode,
    serverId,
    autocompleteCwd,
    hasClient: Boolean(client),
    isConnected,
  });

  const fileSuggestionsQuery = useQuery({
    queryKey: [
      "directorySuggestions",
      serverId,
      autocompleteCwd,
      debouncedFileFilterQuery,
      true,
      true,
    ],
    queryFn: async (): Promise<DirectorySuggestionEntry[]> => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      const response = await client.getDirectorySuggestions({
        cwd: autocompleteCwd,
        query: debouncedFileFilterQuery,
        limit: 50,
        includeFiles: true,
        includeDirectories: true,
      });
      if (response.error) {
        throw new Error(response.error);
      }
      return mapDirectorySuggestionsToEntries(response);
    },
    enabled: canLoadFileSuggestions,
    retry: false,
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });

  const options = useMemo<AgentAutocompleteOption[]>(
    () =>
      buildCommandAutocompleteOptions({
        activeFileMention,
        commandFilterQuery,
        commands,
        activeSlashCommand,
        agentSuggestions,
        fileSuggestions: fileSuggestionsQuery.data ?? [],
        isDraftContext,
        isVisible,
        mode,
        t,
      }),
    [
      activeFileMention,
      activeSlashCommand,
      agentSuggestions,
      commandFilterQuery,
      commands,
      fileSuggestionsQuery.data,
      isDraftContext,
      isVisible,
      mode,
      t,
    ],
  );

  const onSelectOption = useCallback(
    (option: AutocompleteOption, snapshot?: AgentAutocompleteInputSnapshot) => {
      const selected = option as AgentAutocompleteOption;
      const current = resolveAgentAutocompleteSnapshot({
        input: snapshot,
        userInput,
        cursorIndex,
        activeSlashCommand,
        activeFileMention,
      });
      const selectedIsCommand =
        selected.type === "client_command" || selected.type === "provider_command";
      if (snapshot && selectedIsCommand && !current.slashCommand) return;
      if (
        selected.type === "client_command" &&
        selected.command.execution === "immediate" &&
        canExecuteClientSlashCommand &&
        onClientSlashCommand
      ) {
        onClientSlashCommand(selected.command);
        return;
      }

      if (selectedIsCommand) {
        if (!current.slashCommand) {
          setUserInput(`/${selected.id} `);
          onAutocompleteApplied?.();
          return;
        }

        const nextInput = applySlashCommandReplacement({
          text: current.text,
          command: current.slashCommand,
          commandName: selected.id,
        });
        setUserInput(nextInput);
        onAutocompleteApplied?.();
        return;
      }

      if (!current.fileMention) return;

      if (selected.type === "agent") {
        if (onSelectAgent?.(selected.agent) === false) {
          return;
        }
        const nextInput = applyAgentMentionReplacement({
          text: current.text,
          mention: current.fileMention,
        });
        setUserInput(nextInput);
        onAutocompleteApplied?.();
        return;
      }

      const nextInput = applyFileMentionReplacement({
        text: current.text,
        mention: current.fileMention,
        relativePath: selected.entryPath,
      });
      setUserInput(nextInput);
      onAutocompleteApplied?.();
    },
    [
      canExecuteClientSlashCommand,
      onAutocompleteApplied,
      onClientSlashCommand,
      onSelectAgent,
      setUserInput,
      userInput,
      cursorIndex,
      activeFileMention,
      activeSlashCommand,
    ],
  );

  const selectOptionFromKeyPress = useCallback(
    (option: AutocompleteOption, event?: AgentAutocompleteKeyPressEvent) =>
      onSelectOption(option, event?.input),
    [onSelectOption],
  );

  const { selectedIndex, onKeyPress } = useAutocomplete({
    isVisible,
    options,
    query: mode === "command" ? commandFilterQuery : fileFilterQuery,
    onSelectOption: selectOptionFromKeyPress,
    onEscape:
      mode === "command" && activeSlashCommand?.position === "start"
        ? () => setUserInput("")
        : undefined,
  });

  const fileSuggestionsLoadingState = resolveFileSuggestionsLoadingState({
    enabled: canLoadFileSuggestions,
    isPending: fileSuggestionsQuery.isPending,
    isLoading: fileSuggestionsQuery.isLoading,
  });
  const isLoading = resolveAutocompleteIsLoading({
    mode,
    isCommandsLoading,
    fileSuggestionsIsPending: fileSuggestionsLoadingState.isPending,
    fileSuggestionsIsLoading: fileSuggestionsLoadingState.isLoading,
    agentHistoryIsInitialLoad: agentHistory.isInitialLoad,
    optionsLength: options.length,
  });
  const errorMessage = resolveAutocompleteErrorMessage({
    mode,
    isCommandError: isError,
    commandError: error,
    fileSuggestionsError: fileSuggestionsQuery.error,
    isAgentHistoryError: agentHistory.isError,
    optionsLength: options.length,
    t,
  });

  const { loadingText, emptyText } = resolveAutocompleteCopy({ mode, canSelectAgents, t });

  return {
    isVisible,
    options,
    selectedIndex,
    isLoading,
    errorMessage,
    loadingText,
    emptyText,
    onSelectOption,
    onKeyPress,
  };
}

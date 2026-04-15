import { useCallback, useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { AutocompleteOption } from "@/components/ui/autocomplete";
import { useAgentCommandsQuery, type DraftCommandConfig } from "./use-agent-commands-query";
import { orderAutocompleteOptions } from "@/components/ui/autocomplete-utils";
import { useAutocomplete } from "./use-autocomplete";
import { useSessionStore } from "@/stores/session-store";
import { useSlashCommandUsageStore } from "@/stores/slash-command-usage-store";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import {
  applyFileMentionReplacement,
  findActiveFileMention,
  type FileMentionRange,
} from "@/utils/file-mention-autocomplete";
import { rankSlashCommandsByUsage } from "@/utils/slash-command-usage";

interface UseAgentAutocompleteInput {
  userInput: string;
  cursorIndex: number;
  setUserInput: (nextValue: string) => void;
  serverId: string;
  agentId: string;
  draftConfig?: DraftCommandConfig;
  onAutocompleteApplied?: () => void;
}

type AgentAutocompleteOption =
  | (AutocompleteOption & { type: "command" })
  | (AutocompleteOption & {
      type: "workspace_entry";
      entryPath: string;
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
  onSelectOption: (option: AutocompleteOption) => void;
  onKeyPress: (event: { key: string; preventDefault: () => void }) => boolean;
}

interface DirectorySuggestionEntry {
  path: string;
  kind: "file" | "directory";
}

type AutocompleteMode = "command" | "file" | null;

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

function getAutocompleteMode(args: {
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

function getIsAutocompleteVisible(args: {
  mode: AutocompleteMode;
  canLoadCommands: boolean;
  serverId: string;
  autocompleteCwd: string;
}): boolean {
  if (args.mode === "command") {
    return args.canLoadCommands;
  }

  if (args.mode === "file") {
    return Boolean(args.serverId) && args.autocompleteCwd.length > 0;
  }

  return false;
}

function getAutocompleteLoadingState(args: {
  mode: AutocompleteMode;
  isCommandsLoading: boolean;
  isFileSuggestionsPending: boolean;
  isFileSuggestionsLoading: boolean;
  optionCount: number;
}): boolean {
  if (args.mode === "command") {
    return args.isCommandsLoading;
  }

  if (args.mode === "file") {
    return (
      args.isFileSuggestionsPending || (args.isFileSuggestionsLoading && args.optionCount === 0)
    );
  }

  return false;
}

function getAutocompleteErrorMessage(args: {
  mode: AutocompleteMode;
  isCommandError: boolean;
  commandError: Error | null;
  fileSuggestionsError: unknown;
}): string | undefined {
  if (args.mode === "command") {
    return args.isCommandError ? (args.commandError?.message ?? "Failed to load") : undefined;
  }

  if (args.mode === "file" && args.fileSuggestionsError instanceof Error) {
    return args.fileSuggestionsError.message;
  }

  return undefined;
}

export function useAgentAutocomplete(input: UseAgentAutocompleteInput): AgentAutocompleteResult {
  const {
    userInput,
    cursorIndex,
    setUserInput,
    serverId,
    agentId,
    draftConfig,
    onAutocompleteApplied,
  } = input;

  const showCommandAutocomplete = userInput.startsWith("/") && !userInput.includes(" ");
  const commandFilterQuery = showCommandAutocomplete ? userInput.slice(1) : "";

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

  const normalizedDraftConfig = useMemo(
    () => normalizeDraftCommandConfig(draftConfig),
    [draftConfig],
  );

  const isDraftContext = normalizedDraftConfig !== undefined;
  const queryDraftConfig = normalizedDraftConfig;
  const canLoadCommands = Boolean(serverId) && (Boolean(agentId) || isDraftContext);

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
  const commandUsageCounts = useSlashCommandUsageStore((state) => state.usageCountsByCommand);

  const mode = getAutocompleteMode({
    showFileAutocomplete,
    showCommandAutocomplete,
  });
  const isVisible = getIsAutocompleteVisible({
    mode,
    canLoadCommands,
    serverId,
    autocompleteCwd,
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

  const fileSuggestionsQuery = useQuery({
    queryKey: ["directorySuggestions", serverId, autocompleteCwd, fileFilterQuery, true, true],
    queryFn: async (): Promise<DirectorySuggestionEntry[]> => {
      if (!client) {
        throw new Error("Daemon client unavailable");
      }
      const response = await client.getDirectorySuggestions({
        cwd: autocompleteCwd,
        query: fileFilterQuery,
        limit: 50,
        includeFiles: true,
        includeDirectories: true,
      });
      if (response.error) {
        throw new Error(response.error);
      }
      return mapDirectorySuggestionsToEntries(response);
    },
    enabled:
      mode === "file" &&
      Boolean(serverId) &&
      autocompleteCwd.length > 0 &&
      Boolean(client) &&
      isConnected,
    retry: false,
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });

  const options = useMemo<AgentAutocompleteOption[]>(() => {
    if (!isVisible) {
      return [];
    }

    if (mode === "command") {
      const filterLower = commandFilterQuery.toLowerCase();
      const matches = commands.filter((cmd) => cmd.name.toLowerCase().includes(filterLower));
      const rankedMatches = rankSlashCommandsByUsage(matches, commandUsageCounts);
      const orderedMatches = orderAutocompleteOptions(rankedMatches);
      return orderedMatches.map((cmd) => ({
        type: "command" as const,
        id: cmd.name,
        label: `/${cmd.name}`,
        detail: cmd.argumentHint || undefined,
        description: cmd.description,
        kind: "command",
      }));
    }

    if (mode === "file" && activeFileMention) {
      const orderedEntries = orderAutocompleteOptions(fileSuggestionsQuery.data ?? []);
      return orderedEntries.map((entry) => ({
        type: "workspace_entry" as const,
        id: `${entry.kind}:${entry.path}`,
        label: entry.path,
        kind: entry.kind,
        entryPath: entry.path,
        mention: activeFileMention,
      }));
    }

    return [];
  }, [
    activeFileMention,
    commandFilterQuery,
    commandUsageCounts,
    commands,
    fileSuggestionsQuery.data,
    isVisible,
    mode,
  ]);

  const onSelectOption = useCallback(
    (option: AutocompleteOption) => {
      const selected = option as AgentAutocompleteOption;
      if (selected.type === "command") {
        setUserInput(`/${selected.id} `);
        onAutocompleteApplied?.();
        return;
      }

      const nextInput = applyFileMentionReplacement({
        text: userInput,
        mention: selected.mention,
        relativePath: selected.entryPath,
      });
      setUserInput(nextInput);
      onAutocompleteApplied?.();
    },
    [onAutocompleteApplied, setUserInput, userInput],
  );

  const { selectedIndex, onKeyPress } = useAutocomplete({
    isVisible,
    options,
    query: mode === "command" ? commandFilterQuery : fileFilterQuery,
    onSelectOption,
    onEscape: mode === "command" ? () => setUserInput("") : undefined,
  });

  const isLoading = getAutocompleteLoadingState({
    mode,
    isCommandsLoading,
    isFileSuggestionsPending: fileSuggestionsQuery.isPending,
    isFileSuggestionsLoading: fileSuggestionsQuery.isLoading,
    optionCount: options.length,
  });
  const errorMessage = getAutocompleteErrorMessage({
    mode,
    isCommandError: isError,
    commandError: error ?? null,
    fileSuggestionsError: fileSuggestionsQuery.error,
  });

  const loadingText = mode === "file" ? "Searching workspace..." : "Loading commands...";
  const emptyText = mode === "file" ? "No files or directories found" : "No commands found";

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

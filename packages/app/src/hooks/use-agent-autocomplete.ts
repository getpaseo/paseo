import { useCallback, useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { AutocompleteOption } from "@/components/ui/autocomplete";
import { useAgentCommandsQuery, type DraftCommandConfig } from "./use-agent-commands-query";
import { orderAutocompleteOptions } from "@/components/ui/autocomplete-utils";
import { useAutocomplete } from "./use-autocomplete";
import { useSessionStore } from "@/stores/session-store";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import {
  applyFileMentionReplacement,
  findActiveFileMention,
  type FileMentionRange,
} from "@/utils/file-mention-autocomplete";

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
  | (AutocompleteOption & { type: "local_command" })
  | (AutocompleteOption & {
      type: "workspace_entry";
      entryPath: string;
      mention: FileMentionRange;
    });

interface CommandSuggestion {
  name: string;
  description: string;
  argumentHint?: string;
}

const LOCAL_COMMAND_OPTIONS = [
  {
    type: "local_command" as const,
    id: "q",
    label: "/q",
    description: "Paseo local - detach and leave the provider session resumable",
    kind: "command" as const,
  },
  {
    type: "local_command" as const,
    id: "exit",
    label: "/exit",
    description: "Paseo local - detach and leave the provider session resumable",
    kind: "command" as const,
  },
] satisfies AgentAutocompleteOption[];

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

type AutocompleteMode = "command" | "file" | null;

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
}): boolean {
  if (args.mode === "command") {
    return args.canLoadCommands;
  }
  if (args.mode === "file") {
    return Boolean(args.serverId) && args.autocompleteCwd.length > 0;
  }
  return false;
}

function resolveAutocompleteIsLoading(args: {
  mode: AutocompleteMode;
  isCommandsLoading: boolean;
  fileSuggestionsIsPending: boolean;
  fileSuggestionsIsLoading: boolean;
  optionsLength: number;
}): boolean {
  if (args.mode === "command") {
    return args.isCommandsLoading;
  }
  if (args.mode === "file") {
    return (
      args.fileSuggestionsIsPending || (args.fileSuggestionsIsLoading && args.optionsLength === 0)
    );
  }
  return false;
}

function resolveAutocompleteErrorMessage(args: {
  mode: AutocompleteMode;
  isCommandError: boolean;
  commandError: Error | null;
  fileSuggestionsError: unknown;
}): string | undefined {
  if (args.mode === "command") {
    return args.isCommandError ? (args.commandError?.message ?? "Failed to load") : undefined;
  }
  if (args.mode === "file") {
    return args.fileSuggestionsError instanceof Error
      ? args.fileSuggestionsError.message
      : undefined;
  }
  return undefined;
}

function buildCommandAutocompleteOptions(input: {
  commands: CommandSuggestion[];
  query: string;
}): AgentAutocompleteOption[] {
  const filterLower = input.query.toLowerCase();
  const providerOptions = input.commands.map((cmd) => ({
    type: "command" as const,
    id: cmd.name,
    label: `/${cmd.name}`,
    description: formatCommandDescription(cmd),
    kind: "command" as const,
  }));
  return orderCommandAutocompleteOptions(
    [...LOCAL_COMMAND_OPTIONS, ...providerOptions],
    filterLower,
  );
}

function formatCommandDescription(command: CommandSuggestion): string {
  const description = command.description.trim();
  const argumentHint = command.argumentHint?.trim() ?? "";
  if (!argumentHint) {
    return description;
  }
  return description ? `${description} - ${argumentHint}` : argumentHint;
}

function getCommandMatchRank(commandName: string, query: string): number | null {
  if (!query) {
    return 0;
  }
  const normalized = commandName.toLowerCase();
  if (normalized === query) {
    return 0;
  }
  if (normalized.startsWith(query)) {
    return 1;
  }
  if (normalized.includes(query)) {
    return 2;
  }
  return null;
}

function orderCommandAutocompleteOptions(
  options: AgentAutocompleteOption[],
  query: string,
): AgentAutocompleteOption[] {
  return options
    .map((option, index) => ({ option, index, rank: getCommandMatchRank(option.id, query) }))
    .filter(
      (entry): entry is { option: AgentAutocompleteOption; index: number; rank: number } =>
        entry.rank !== null,
    )
    .sort((left, right) => {
      if (left.rank !== right.rank) {
        return left.rank - right.rank;
      }
      if (left.option.type !== right.option.type) {
        return left.option.type === "local_command" ? -1 : 1;
      }
      return left.index - right.index;
    })
    .map((entry) => entry.option);
}

function buildPresentedCommandAutocompleteOptions(input: {
  commands: CommandSuggestion[];
  query: string;
}): AgentAutocompleteOption[] {
  return orderAutocompleteOptions(buildCommandAutocompleteOptions(input));
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
  const queryDraftConfig = isDraftContext ? normalizedDraftConfig : undefined;
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

  const mode = resolveAutocompleteMode({ showFileAutocomplete, showCommandAutocomplete });
  const isVisible = resolveAutocompleteIsVisible({
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
        throw new Error("Daemon client unavailable");
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
      return buildPresentedCommandAutocompleteOptions({ commands, query: commandFilterQuery });
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
  }, [activeFileMention, commandFilterQuery, commands, fileSuggestionsQuery.data, isVisible, mode]);

  const onSelectOption = useCallback(
    (option: AutocompleteOption) => {
      const selected = option as AgentAutocompleteOption;
      if (selected.type === "command" || selected.type === "local_command") {
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

  const isLoading = resolveAutocompleteIsLoading({
    mode,
    isCommandsLoading,
    fileSuggestionsIsPending: fileSuggestionsQuery.isPending,
    fileSuggestionsIsLoading: fileSuggestionsQuery.isLoading,
    optionsLength: options.length,
  });
  const errorMessage = resolveAutocompleteErrorMessage({
    mode,
    isCommandError: isError,
    commandError: error,
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

export const __private__ = {
  buildCommandAutocompleteOptions,
  buildPresentedCommandAutocompleteOptions,
  formatCommandDescription,
  orderCommandAutocompleteOptions,
};

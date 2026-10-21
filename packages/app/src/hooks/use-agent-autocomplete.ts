import { useCallback, useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { AutocompleteOption } from "@/components/ui/autocomplete";
import {
  useAgentCommandsQuery,
  type AgentSlashCommand,
  type DraftCommandConfig,
  type DraftCommandTarget,
} from "./use-agent-commands-query";
import { orderAutocompleteOptions } from "@/components/ui/autocomplete-utils";
import { useAutocomplete } from "./use-autocomplete";
import { useSessionStore } from "@/stores/session-store";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { CLIENT_SLASH_COMMANDS, type ClientSlashCommand } from "@/client-slash-commands";
import type { PluginClientSlashCommand } from "@/plugins/client-slash-commands";
import { mergeSlashCommandSources } from "@/plugins/client-slash-commands/model";
import {
  applySlashCommandReplacement,
  filterAndRankCommandAutocompleteEntries,
  filterInlineSkillCommandEntries,
  findActiveSlashCommand,
  type SlashCommandRange,
} from "@/utils/agent-command-autocomplete";
import {
  applyFileMentionReplacement,
  findActiveFileMention,
  type FileMentionRange,
} from "@/utils/file-mention-autocomplete";
import { usePluginAttachmentMentions } from "@/plugins/attachments/use-mentions";
import {
  selectAttachmentMention,
  isAttachmentMentionOption,
  type AttachmentMentionOption,
} from "@/plugins/attachments/mentions";
import type { PluginResourceComposerAttachment } from "@/plugins/attachments/model";

interface UseAgentAutocompleteInput {
  userInput: string;
  cursorIndex: number;
  setUserInput: (nextValue: string, selection?: { start: number; end: number }) => void;
  serverId: string;
  agentId: string;
  draft?: DraftCommandTarget;
  onAutocompleteApplied?: () => void;
  onClientSlashCommand?: (command: ClientSlashCommand) => void;
  canExecuteClientSlashCommand?: boolean;
  pluginClientSlashCommands?: readonly PluginClientSlashCommand[];
  onPluginAttachment: (attachment: PluginResourceComposerAttachment) => void;
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
  | AttachmentMentionOption
  | (AutocompleteOption & { type: "client_command"; command: ClientSlashCommand })
  | (AutocompleteOption & {
      type: "plugin_command";
      command: PluginClientSlashCommand;
    })
  | (AutocompleteOption & { type: "provider_command" })
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

interface DirectorySuggestionEntry {
  path: string;
  kind: "file" | "directory";
}

function selectWorkspaceMention(input: {
  text: string;
  mention: FileMentionRange | null;
  option: Extract<AgentAutocompleteOption, { type: "workspace_entry" }>;
}): string | null {
  if (!input.mention || input.mention.query !== input.option.mention.query) return null;
  return applyFileMentionReplacement({
    text: input.text,
    mention: input.mention,
    relativePath: input.option.entryPath,
  });
}

function currentFileSuggestions(input: {
  data: DirectorySuggestionEntry[] | undefined;
  query: string;
  requestQuery: string;
  isPlaceholderData: boolean;
}): DirectorySuggestionEntry[] {
  if (input.query !== input.requestQuery || input.isPlaceholderData) return [];
  return input.data ?? [];
}

type AvailableCommand =
  | { source: "client"; command: ClientSlashCommand }
  | { source: "plugin"; command: PluginClientSlashCommand }
  | { source: "provider"; command: AgentSlashCommand };

function resolveDraftQueryConfig(draft?: DraftCommandTarget): DraftCommandConfig | undefined {
  if (draft?.status !== "ready") {
    return undefined;
  }

  const draftConfig = draft.config;
  const cwd = draftConfig.cwd.trim();
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
  if (entry.source === "plugin") {
    return { ...base, type: "plugin_command", command: entry.command };
  }
  return {
    ...base,
    type: "provider_command",
  };
}

type AutocompleteMode = "command" | "file" | null;

interface BuildAutocompleteOptionsInput {
  isVisible: boolean;
  mode: AutocompleteMode;
  commands: AgentSlashCommand[];
  pluginCommands: readonly PluginClientSlashCommand[];
  isDraftContext: boolean;
  commandFilterQuery: string;
  activeSlashCommand: SlashCommandRange | null;
  activeFileMention: FileMentionRange | null;
  fileSuggestions: DirectorySuggestionEntry[];
  t: TFunction;
}

function buildCommandAutocompleteOptions(input: BuildAutocompleteOptionsInput) {
  if (!input.isVisible) {
    return [];
  }

  if (input.mode === "command") {
    const providerCommands = input.commands.map((command) => ({
      source: "provider" as const,
      command,
    }));
    const rootCommands: AvailableCommand[] = mergeSlashCommandSources({
      builtIn: CLIENT_SLASH_COMMANDS,
      plugins: input.pluginCommands,
      provider: input.commands,
      onPluginCollision(command, winner) {
        console.warn(
          `[Plugins] Client slash command /${command.name} from ${command.pluginId} ignored; ${winner} command wins`,
        );
      },
    })
      .filter((entry) => !input.isDraftContext || entry.source !== "built-in")
      .map((entry): AvailableCommand => {
        if (entry.source === "built-in") return { source: "client", command: entry.command };
        return entry;
      });
    const availableCommands: AvailableCommand[] =
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
    const orderedEntries = orderAutocompleteOptions(input.fileSuggestions);
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
  hasAttachmentMentions: boolean;
}): boolean {
  if (args.mode === "command") {
    return args.canLoadCommands;
  }
  if (args.mode === "file") {
    return (
      Boolean(args.serverId) && (args.autocompleteCwd.length > 0 || args.hasAttachmentMentions)
    );
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
  fileLookupEnabled: boolean;
  fileQuery: string;
  fileRequestQuery: string;
  fileSuggestionsFetching: boolean;
  optionsLength: number;
}): boolean {
  if (args.mode === "command") {
    return args.isCommandsLoading && args.optionsLength === 0;
  }
  if (args.mode === "file") {
    const lookupPending =
      args.fileLookupEnabled &&
      (args.fileQuery !== args.fileRequestQuery || args.fileSuggestionsFetching);
    return lookupPending && args.optionsLength === 0;
  }
  return false;
}

function resolveAutocompleteErrorMessage(args: {
  mode: AutocompleteMode;
  isCommandError: boolean;
  commandError: Error | null;
  fileSuggestionsError: unknown;
  t: TFunction;
}): string | undefined {
  if (args.mode === "command") {
    return args.isCommandError
      ? (args.commandError?.message ?? args.t("agentAutocomplete.failedToLoad"))
      : undefined;
  }
  if (args.mode === "file") {
    return args.fileSuggestionsError instanceof Error
      ? args.fileSuggestionsError.message
      : undefined;
  }
  return undefined;
}

// A draft's agentId is a draft key the daemon does not know, so a draft lists
// commands by its config only, and not at all until that config is complete.
function resolveDraftCommandContext(draft: DraftCommandTarget | undefined) {
  const queryDraftConfig = resolveDraftQueryConfig(draft);
  const isDraftContext = draft !== undefined;
  return {
    isDraftContext,
    queryDraftConfig,
    canListCommands: !isDraftContext || queryDraftConfig !== undefined,
  };
}

function resolveAutocompleteEmptyText(args: {
  mode: AutocompleteMode;
  draft: DraftCommandTarget | undefined;
  autocompleteCwd: string;
  t: TFunction;
}): string {
  if (args.mode === "file") {
    if (!args.autocompleteCwd) return args.t("common.empty.noResults");
    return args.t("agentAutocomplete.noFiles");
  }
  if (args.draft?.status === "needs-project") {
    return args.t("agentAutocomplete.chooseProjectForCommands");
  }
  if (args.draft?.status === "needs-provider") {
    return args.t("agentAutocomplete.chooseModelForCommands");
  }
  return args.t("agentAutocomplete.noCommands");
}

function resolveAutocompletePresentation(input: {
  mode: AutocompleteMode;
  draft: DraftCommandTarget | undefined;
  autocompleteCwd: string;
  t: TFunction;
  builtInLoading: boolean;
  builtInError: string | undefined;
  plugin: Pick<
    ReturnType<typeof usePluginAttachmentMentions>,
    "scoped" | "isLoading" | "errorMessage" | "options"
  >;
}) {
  if (input.plugin.scoped) {
    return {
      isLoading: input.plugin.isLoading,
      errorMessage: input.plugin.errorMessage,
      loadingText: input.t("common.states.loading"),
      emptyText: input.t("common.empty.noResults"),
    };
  }
  const loadingText =
    input.mode === "file"
      ? input.t("agentAutocomplete.searchingWorkspace")
      : input.t("agentAutocomplete.loadingCommands");
  const hasPluginSources = input.mode === "file" && input.plugin.options.length > 0;
  return {
    isLoading: input.builtInLoading,
    errorMessage: hasPluginSources ? undefined : input.builtInError,
    loadingText,
    emptyText: resolveAutocompleteEmptyText(input),
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
    draft,
    onAutocompleteApplied,
    onClientSlashCommand,
    canExecuteClientSlashCommand,
    pluginClientSlashCommands = [],
    onPluginAttachment,
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

  const { isDraftContext, queryDraftConfig, canListCommands } = useMemo(
    () => resolveDraftCommandContext(draft),
    [draft],
  );
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
  const pluginMentions = usePluginAttachmentMentions({
    serverId,
    client,
    connected: isConnected,
    mention: activeFileMention,
  });

  const mode = resolveAutocompleteMode({ showFileAutocomplete, showCommandAutocomplete });
  const canShowAutocomplete = resolveAutocompleteIsVisible({
    mode,
    canLoadCommands,
    serverId,
    autocompleteCwd,
    hasAttachmentMentions: pluginMentions.hasSources,
  });

  const commandsQuery = useAgentCommandsQuery({
    serverId,
    agentId,
    enabled: mode === "command" && canLoadCommands && canListCommands,
    draftConfig: queryDraftConfig,
  });
  const { commands, isError, error } = commandsQuery;
  const isCommandsLoading = canListCommands && commandsQuery.isLoading;

  const isVisible = canShowAutocomplete && !(mode === "command" && isCommandsLoading);

  const fileSuggestionsEnabled =
    mode === "file" &&
    !pluginMentions.scoped &&
    Boolean(serverId) &&
    autocompleteCwd.length > 0 &&
    Boolean(client) &&
    isConnected;
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
    enabled: fileSuggestionsEnabled,
    retry: false,
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });

  const options = useMemo<AgentAutocompleteOption[]>(() => {
    const builtIn = buildCommandAutocompleteOptions({
      activeFileMention,
      commandFilterQuery,
      commands,
      pluginCommands: pluginClientSlashCommands,
      activeSlashCommand,
      fileSuggestions: currentFileSuggestions({
        data: fileSuggestionsQuery.data,
        query: fileFilterQuery,
        requestQuery: debouncedFileFilterQuery,
        isPlaceholderData: fileSuggestionsQuery.isPlaceholderData,
      }),
      isDraftContext,
      isVisible,
      mode,
      t,
    });
    if (!isVisible || mode !== "file") return builtIn;
    const pluginOptions = orderAutocompleteOptions(pluginMentions.options);
    if (pluginMentions.scoped) return pluginOptions;
    return [...pluginOptions, ...builtIn];
  }, [
    activeFileMention,
    activeSlashCommand,
    commandFilterQuery,
    commands,
    pluginClientSlashCommands,
    fileSuggestionsQuery.data,
    fileSuggestionsQuery.isPlaceholderData,
    fileFilterQuery,
    debouncedFileFilterQuery,
    isDraftContext,
    isVisible,
    mode,
    pluginMentions.options,
    pluginMentions.scoped,
    t,
  ]);

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
      if (isAttachmentMentionOption(selected)) {
        const selection = selectAttachmentMention({
          option: selected,
          text: current.text,
          mention: current.fileMention,
          scoped: pluginMentions.scoped,
        });
        if (!selection) return;
        if (selection.attachment) onPluginAttachment(selection.attachment);
        setUserInput(selection.text, selection.selection);
        onAutocompleteApplied?.();
        return;
      }
      const selectedIsCommand =
        selected.type === "client_command" ||
        selected.type === "plugin_command" ||
        selected.type === "provider_command";
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

      const nextInput = selectWorkspaceMention({
        text: current.text,
        mention: current.fileMention,
        option: selected,
      });
      if (nextInput === null) return;
      setUserInput(nextInput);
      onAutocompleteApplied?.();
    },
    [
      canExecuteClientSlashCommand,
      onAutocompleteApplied,
      onClientSlashCommand,
      setUserInput,
      userInput,
      cursorIndex,
      activeFileMention,
      activeSlashCommand,
      onPluginAttachment,
      pluginMentions.scoped,
    ],
  );

  const selectOptionFromKeyPress = useCallback(
    (option: AutocompleteOption, event?: AgentAutocompleteKeyPressEvent) =>
      onSelectOption(option, event?.input),
    [onSelectOption],
  );

  const builtInLoading = resolveAutocompleteIsLoading({
    mode,
    isCommandsLoading,
    fileLookupEnabled: fileSuggestionsEnabled,
    fileQuery: fileFilterQuery,
    fileRequestQuery: debouncedFileFilterQuery,
    fileSuggestionsFetching: fileSuggestionsQuery.isFetching,
    optionsLength: options.length,
  });
  const builtInError = resolveAutocompleteErrorMessage({
    mode,
    isCommandError: isError,
    commandError: error,
    fileSuggestionsError: fileSuggestionsQuery.error,
    t,
  });

  const presentation = resolveAutocompletePresentation({
    mode,
    draft,
    autocompleteCwd,
    t,
    builtInLoading,
    builtInError,
    plugin: pluginMentions,
  });

  const { selectedIndex, onKeyPress: onAutocompleteKeyPress } = useAutocomplete({
    isVisible,
    isLoading: presentation.isLoading,
    options,
    query: mode === "command" ? commandFilterQuery : fileFilterQuery,
    onSelectOption: selectOptionFromKeyPress,
    onEscape:
      mode === "command" && activeSlashCommand?.position === "start"
        ? () => setUserInput("")
        : undefined,
  });

  const onKeyPress = useCallback(
    (event: AgentAutocompleteKeyPressEvent) => {
      if (event.key !== "Enter" && event.key !== "Tab") return onAutocompleteKeyPress(event);
      const mention = findActiveFileMention({
        text: event.input.text,
        cursorIndex: event.input.selection.start,
      });
      const canShowMentions = resolveAutocompleteIsVisible({
        mode: "file",
        canLoadCommands,
        serverId,
        autocompleteCwd,
        hasAttachmentMentions: pluginMentions.hasSources,
      });
      if (canShowMentions && mention && mention.query !== activeFileMention?.query) {
        event.preventDefault();
        return true;
      }
      return onAutocompleteKeyPress(event);
    },
    [
      onAutocompleteKeyPress,
      activeFileMention,
      canLoadCommands,
      serverId,
      autocompleteCwd,
      pluginMentions.hasSources,
    ],
  );

  return {
    isVisible,
    options,
    selectedIndex,
    ...presentation,
    onSelectOption,
    onKeyPress,
  };
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useAgentCommandsQuery,
  type DraftCommandConfig,
} from "@/hooks/use-agent-commands-query";
import type { AutocompleteOption } from "@/components/ui/autocomplete";
import {
  getAutocompleteFallbackIndex,
  getAutocompleteNextIndex,
  orderAutocompleteOptions,
} from "@/components/ui/autocomplete-utils";

interface UseCommandAutocompleteInput {
  userInput: string;
  setUserInput: (nextValue: string) => void;
  serverId: string;
  agentId: string;
  draftConfig?: DraftCommandConfig;
  onCommandApplied?: () => void;
}

interface CommandAutocompleteResult {
  isVisible: boolean;
  options: AutocompleteOption[];
  selectedIndex: number;
  isLoading: boolean;
  errorMessage?: string;
  onSelectOption: (option: AutocompleteOption) => void;
  onKeyPress: (event: { key: string; preventDefault: () => void }) => boolean;
}

function normalizeDraftCommandConfig(
  draftConfig?: DraftCommandConfig
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
  return {
    provider: draftConfig.provider,
    cwd,
    ...(modeId ? { modeId } : {}),
    ...(model ? { model } : {}),
    ...(thinkingOptionId ? { thinkingOptionId } : {}),
  };
}

export function useCommandAutocomplete(
  input: UseCommandAutocompleteInput
): CommandAutocompleteResult {
  const {
    userInput,
    setUserInput,
    serverId,
    agentId,
    draftConfig,
    onCommandApplied,
  } = input;
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const previousFilterRef = useRef("");

  const showCommandAutocomplete =
    userInput.startsWith("/") && !userInput.includes(" ");
  const commandFilter = showCommandAutocomplete ? userInput.slice(1) : "";

  const normalizedDraftConfig = useMemo(
    () => normalizeDraftCommandConfig(draftConfig),
    [draftConfig]
  );

  const isRealAgent = Boolean(agentId) && !agentId.startsWith("__");
  const queryDraftConfig = isRealAgent ? undefined : normalizedDraftConfig;
  const canLoadCommands = Boolean(serverId) && (isRealAgent || !!queryDraftConfig);
  const isVisible = showCommandAutocomplete && canLoadCommands;

  const { commands, isLoading, isError, error } = useAgentCommandsQuery({
    serverId,
    agentId,
    enabled: canLoadCommands,
    draftConfig: queryDraftConfig,
  });

  const filteredCommands = useMemo(() => {
    if (!isVisible) {
      return [];
    }
    const filterLower = commandFilter.toLowerCase();
    const matches = commands.filter((cmd) =>
      cmd.name.toLowerCase().includes(filterLower)
    );
    return orderAutocompleteOptions(matches);
  }, [commandFilter, commands, isVisible]);

  const options = useMemo<AutocompleteOption[]>(
    () =>
      filteredCommands.map((cmd) => ({
        id: cmd.name,
        label: `/${cmd.name}`,
        detail: cmd.argumentHint || undefined,
        description: cmd.description,
      })),
    [filteredCommands]
  );

  useEffect(() => {
    if (!isVisible) {
      previousFilterRef.current = commandFilter;
      setSelectedIndex(-1);
      return;
    }

    const filterChanged = previousFilterRef.current !== commandFilter;
    previousFilterRef.current = commandFilter;

    setSelectedIndex((current) => {
      if (options.length === 0) {
        return -1;
      }
      if (filterChanged) {
        return getAutocompleteFallbackIndex(options.length);
      }
      if (current < 0 || current >= options.length) {
        return getAutocompleteFallbackIndex(options.length);
      }
      return current;
    });
  }, [commandFilter, isVisible, options.length]);

  const applyCommandByName = useCallback(
    (commandName: string) => {
      setUserInput(`/${commandName} `);
      onCommandApplied?.();
    },
    [onCommandApplied, setUserInput]
  );

  const onSelectOption = useCallback(
    (option: AutocompleteOption) => {
      applyCommandByName(option.id);
    },
    [applyCommandByName]
  );

  const onKeyPress = useCallback(
    (event: { key: string; preventDefault: () => void }) => {
      if (!isVisible || options.length === 0) {
        return false;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIndex((current) =>
          getAutocompleteNextIndex({
            currentIndex: current,
            itemCount: options.length,
            key: "ArrowUp",
          })
        );
        return true;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedIndex((current) =>
          getAutocompleteNextIndex({
            currentIndex: current,
            itemCount: options.length,
            key: "ArrowDown",
          })
        );
        return true;
      }

      if (event.key === "Tab" || event.key === "Enter") {
        event.preventDefault();
        const fallbackIndex = getAutocompleteFallbackIndex(options.length);
        const resolvedIndex =
          selectedIndex >= 0 && selectedIndex < options.length
            ? selectedIndex
            : fallbackIndex;
        const selectedOption = options[resolvedIndex];
        if (selectedOption) {
          onSelectOption(selectedOption);
        }
        return true;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        setUserInput("");
        return true;
      }

      return false;
    },
    [isVisible, onSelectOption, options, selectedIndex, setUserInput]
  );

  return {
    isVisible,
    options,
    selectedIndex,
    isLoading,
    errorMessage: isError ? (error?.message ?? "Failed to load") : undefined,
    onSelectOption,
    onKeyPress,
  };
}

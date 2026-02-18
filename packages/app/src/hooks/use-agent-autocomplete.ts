import { useCallback, useMemo } from "react";
import type { AutocompleteOption } from "@/components/ui/autocomplete";
import { useAgentCommandsQuery, type DraftCommandConfig } from "./use-agent-commands-query";
import { orderAutocompleteOptions } from "@/components/ui/autocomplete-utils";
import { useAutocomplete } from "./use-autocomplete";

interface UseAgentAutocompleteInput {
  userInput: string;
  setUserInput: (nextValue: string) => void;
  serverId: string;
  agentId: string;
  draftConfig?: DraftCommandConfig;
  onAutocompleteApplied?: () => void;
}

interface AgentAutocompleteResult {
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

export function useAgentAutocomplete(
  input: UseAgentAutocompleteInput
): AgentAutocompleteResult {
  const {
    userInput,
    setUserInput,
    serverId,
    agentId,
    draftConfig,
    onAutocompleteApplied,
  } = input;

  const showAutocomplete = userInput.startsWith("/") && !userInput.includes(" ");
  const filterQuery = showAutocomplete ? userInput.slice(1) : "";

  const normalizedDraftConfig = useMemo(
    () => normalizeDraftCommandConfig(draftConfig),
    [draftConfig]
  );

  const isRealAgent = Boolean(agentId) && !agentId.startsWith("__");
  const queryDraftConfig = isRealAgent ? undefined : normalizedDraftConfig;
  const canLoadOptions = Boolean(serverId) && (isRealAgent || !!queryDraftConfig);
  const isVisible = showAutocomplete && canLoadOptions;

  const { commands, isLoading, isError, error } = useAgentCommandsQuery({
    serverId,
    agentId,
    enabled: canLoadOptions,
    draftConfig: queryDraftConfig,
  });

  const options = useMemo<AutocompleteOption[]>(() => {
    if (!isVisible) {
      return [];
    }

    const filterLower = filterQuery.toLowerCase();
    const matches = commands.filter((cmd) =>
      cmd.name.toLowerCase().includes(filterLower)
    );
    const orderedMatches = orderAutocompleteOptions(matches);
    return orderedMatches.map((cmd) => ({
      id: cmd.name,
      label: `/${cmd.name}`,
      detail: cmd.argumentHint || undefined,
      description: cmd.description,
    }));
  }, [commands, filterQuery, isVisible]);

  const onSelectOption = useCallback(
    (option: AutocompleteOption) => {
      setUserInput(`/${option.id} `);
      onAutocompleteApplied?.();
    },
    [onAutocompleteApplied, setUserInput]
  );

  const { selectedIndex, onKeyPress } = useAutocomplete({
    isVisible,
    options,
    query: filterQuery,
    onSelectOption,
    onEscape: () => setUserInput(""),
  });

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

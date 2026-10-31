import { useCallback, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useOpenProject } from "@/hooks/use-open-project";
import { useProjectRootPaths } from "@/stores/session-store-hooks";
import {
  addSuggestedProjects,
  isSuggestionChecked,
  mergeProviderSuggestions,
  type ProjectSuggestion,
  type ProviderSuggestions,
} from "./suggestions";
import { useProviderSuggestions } from "./use-provider-suggestions";

export interface SuggestionRow {
  suggestion: ProjectSuggestion;
  checked: boolean;
  /** Undefined when the folder was not attempted; null when the host gave no reason. */
  addFailure: string | null | undefined;
}

export type SuggestionList =
  | { status: "unsupported" }
  /** Nothing to show yet: the provider list or every provider's first answer is pending. */
  | { status: "loading" }
  | {
      status: "ready";
      rows: SuggestionRow[];
      providerLabels: ReadonlyMap<string, string>;
      reading: ProviderSuggestions[];
      failed: ProviderSuggestions[];
      toggle: (suggestion: ProjectSuggestion) => void;
      retry: (provider: string) => void;
    };

export interface ProjectSuggestionsController {
  list: SuggestionList;
  checkedCount: number;
  isAdding: boolean;
  /** Adds every checked folder. Resolves true when all of them were added. */
  addChecked: () => Promise<boolean>;
}

/**
 * The suggestion list and the user's selection. Whoever owns the step's primary action holds
 * this, so proceeding can add what is checked; calling it early also starts reading history.
 */
export function useProjectSuggestions(serverId: string): ProjectSuggestionsController {
  const state = useProviderSuggestions(serverId);
  const projectRootPaths = useProjectRootPaths(serverId);
  const openProject = useOpenProject(serverId);
  const [now] = useState(() => new Date());
  const [choices, setChoices] = useState<Record<string, boolean>>({});
  const [addFailures, setAddFailures] = useState<Map<string, string | null>>(new Map());

  const providers = state.status === "ready" ? state.providers : null;
  const suggestions = useMemo(
    () => (providers ? mergeProviderSuggestions(providers, new Set(projectRootPaths)) : []),
    [providers, projectRootPaths],
  );
  const checkedRootPaths = useMemo(
    () =>
      suggestions
        .filter((suggestion) => isSuggestionChecked(suggestion, choices, now))
        .map((suggestion) => suggestion.rootPath),
    [suggestions, choices, now],
  );

  const toggle = useCallback(
    (suggestion: ProjectSuggestion) => {
      setChoices((current) => ({
        ...current,
        [suggestion.rootPath]: !isSuggestionChecked(suggestion, current, now),
      }));
    },
    [now],
  );

  const { mutateAsync, isPending } = useMutation({
    mutationFn: (rootPaths: string[]) => addSuggestedProjects(rootPaths, openProject),
    onSuccess: setAddFailures,
  });
  const addChecked = useCallback(async () => {
    const failures = await mutateAsync(checkedRootPaths);
    return failures.size === 0;
  }, [mutateAsync, checkedRootPaths]);

  const list = useMemo((): SuggestionList => {
    if (state.status !== "ready") return state;
    const reading = state.providers.filter((provider) => provider.status === "loading");
    if (suggestions.length === 0 && reading.length > 0) return { status: "loading" };
    return {
      status: "ready",
      rows: suggestions.map((suggestion) => ({
        suggestion,
        checked: checkedRootPaths.includes(suggestion.rootPath),
        addFailure: addFailures.get(suggestion.rootPath),
      })),
      providerLabels: new Map(
        state.providers.map((provider) => [provider.provider, provider.label]),
      ),
      reading,
      failed: state.providers.filter((provider) => provider.status === "failed"),
      toggle,
      retry: state.retry,
    };
  }, [state, suggestions, checkedRootPaths, addFailures, toggle]);

  return { list, checkedCount: checkedRootPaths.length, isAdding: isPending, addChecked };
}

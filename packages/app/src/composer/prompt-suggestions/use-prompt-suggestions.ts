import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/shallow";
import { useSessionStore } from "@/stores/session-store";
import { resolvePromptSuggestionView, type PromptSuggestionView } from "./model";

export interface UsePromptSuggestionsInput {
  serverId: string;
  agentId: string;
  hasText: boolean;
  isAgentRunning: boolean;
  isReadOnly: boolean;
}

export interface PromptSuggestionsState extends PromptSuggestionView {
  dismiss: () => void;
  clear: () => void;
}

export function usePromptSuggestions(input: UsePromptSuggestionsInput): PromptSuggestionsState {
  const stored = useSessionStore(
    useShallow((state) => state.sessions[input.serverId]?.promptSuggestions.get(input.agentId)),
  );
  const clearPromptSuggestions = useSessionStore((state) => state.clearPromptSuggestions);
  // Read from this host's own agent record: the global activity map is replaced
  // by whichever host synced last.
  const lastUserMessageAt = useSessionStore(
    (state) => state.sessions[input.serverId]?.agents.get(input.agentId)?.lastUserMessageAt,
  );
  const [dismissedTurnSeq, setDismissedTurnSeq] = useState<number | null>(null);

  const view = useMemo(
    () =>
      resolvePromptSuggestionView({
        suggestions: stored?.suggestions,
        turnSeq: stored?.turnSeq,
        generatedAt: stored?.generatedAt,
        lastUserMessageAt,
        hasText: input.hasText,
        isAgentRunning: input.isAgentRunning,
        isReadOnly: input.isReadOnly,
        dismissedTurnSeq,
      }),
    [
      stored,
      lastUserMessageAt,
      input.hasText,
      input.isAgentRunning,
      input.isReadOnly,
      dismissedTurnSeq,
    ],
  );

  // A new turn makes the previous guess obsolete, whichever path sent it.
  const wasAgentRunning = useRef(input.isAgentRunning);
  useEffect(() => {
    if (input.isAgentRunning && !wasAgentRunning.current) {
      clearPromptSuggestions(input.serverId, input.agentId);
    }
    wasAgentRunning.current = input.isAgentRunning;
  }, [input.isAgentRunning, input.serverId, input.agentId, clearPromptSuggestions]);

  const dismiss = useCallback(() => {
    if (stored) {
      setDismissedTurnSeq(stored.turnSeq);
    }
  }, [stored]);

  const clear = useCallback(() => {
    clearPromptSuggestions(input.serverId, input.agentId);
  }, [clearPromptSuggestions, input.serverId, input.agentId]);

  return { ghost: view.ghost, chips: view.chips, dismiss, clear };
}

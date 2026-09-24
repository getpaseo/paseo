import { createContext, useContext, type ReactNode } from "react";

export interface RecommendedPromptActions {
  /** Sends the prompt to the agent as a new user message. */
  send: (prompt: string) => Promise<void>;
  /** Puts the prompt into the composer so the user can edit it before sending. */
  useEdited: (prompt: string) => void;
}

const RecommendedPromptActionsContext = createContext<RecommendedPromptActions | null>(null);

/**
 * Provided by the surface that owns a composer for the agent. Read-only surfaces
 * (provider subagents, background activity) never provide it, which hides the prompts.
 */
export function RecommendedPromptActionsProvider({
  value,
  children,
}: {
  value: RecommendedPromptActions;
  children: ReactNode;
}) {
  return (
    <RecommendedPromptActionsContext.Provider value={value}>
      {children}
    </RecommendedPromptActionsContext.Provider>
  );
}

export function useRecommendedPromptActions(): RecommendedPromptActions | null {
  return useContext(RecommendedPromptActionsContext);
}

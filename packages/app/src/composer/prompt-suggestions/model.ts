import type { PromptSuggestion } from "@getpaseo/protocol/messages";

export interface PromptSuggestionViewInput {
  suggestions: readonly PromptSuggestion[] | undefined;
  turnSeq: number | undefined;
  generatedAt: string | undefined;
  lastUserMessageAt: Date | null | undefined;
  hasText: boolean;
  isAgentRunning: boolean;
  isReadOnly: boolean;
  dismissedTurnSeq: number | null;
  // Answers to a question the agent asked belong in that question's own answer
  // box; showing them in the composer would send them as a new message instead.
  answersPermissionId?: string | undefined;
}

export interface PromptSuggestionView {
  ghost: PromptSuggestion | null;
  chips: PromptSuggestion[];
}

const EMPTY_VIEW: PromptSuggestionView = { ghost: null, chips: [] };

// A suggestion is an offer: it occupies only space the user is not using, so a
// draft, a running turn or a dismissal for this turn hides it.
export function resolvePromptSuggestionView(
  input: PromptSuggestionViewInput,
): PromptSuggestionView {
  if (!input.suggestions || input.suggestions.length === 0 || input.turnSeq === undefined) {
    return EMPTY_VIEW;
  }
  if (input.hasText || input.isAgentRunning || input.isReadOnly) {
    return EMPTY_VIEW;
  }
  if (input.answersPermissionId) {
    return EMPTY_VIEW;
  }
  if (input.dismissedTurnSeq !== null && input.dismissedTurnSeq >= input.turnSeq) {
    return EMPTY_VIEW;
  }
  // Only a new user message starts a turn. updatedAt also moves when a chat is
  // opened or renamed, so it would hide a suggestion the user has not seen yet.
  if (isStale(input.generatedAt, input.lastUserMessageAt)) {
    return EMPTY_VIEW;
  }
  const [first, ...rest] = input.suggestions;
  return { ghost: first, chips: rest };
}

function isStale(
  generatedAt: string | undefined,
  lastUserMessageAt: Date | null | undefined,
): boolean {
  if (!generatedAt || !lastUserMessageAt) return false;
  const generated = Date.parse(generatedAt);
  return Number.isFinite(generated) && lastUserMessageAt.getTime() > generated;
}

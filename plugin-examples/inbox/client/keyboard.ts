import type { InboxCard } from "./lanes";
import { buildAnswers, parseQuestions } from "./question-form";
import type { PermissionResponse } from "./types";
import type { WebKeyEvent } from "./web";

export type KeyAction =
  | { kind: "move"; delta: 1 | -1 }
  | { kind: "open" }
  | { kind: "close" }
  | { kind: "option"; index: number }
  | { kind: "allow" }
  | { kind: "deny" };

/** Maps an unmodified keypress outside a text field to a board action. */
export function keyToAction(
  event: Pick<WebKeyEvent, "key" | "metaKey" | "ctrlKey" | "altKey">,
): KeyAction | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  switch (event.key) {
    case "j":
    case "ArrowDown":
      return { kind: "move", delta: 1 };
    case "k":
    case "ArrowUp":
      return { kind: "move", delta: -1 };
    case "Enter":
    case "o":
      return { kind: "open" };
    case "Escape":
      return { kind: "close" };
    case "y":
      return { kind: "allow" };
    case "n":
      return { kind: "deny" };
    default: {
      if (/^[1-9]$/.test(event.key)) return { kind: "option", index: Number(event.key) - 1 };
      return null;
    }
  }
}

/**
 * A digit answers a card only when the answer is unambiguous: one question,
 * single-select, and the digit names an existing option. Anything else returns
 * null and the board opens the peek instead.
 */
export function optionResponse(card: InboxCard, index: number): PermissionResponse | null {
  if (card.reason !== "question" || !card.request) return null;
  const questions = parseQuestions(card.request.input);
  if (!questions || questions.length !== 1) return null;
  const [question] = questions;
  if (question.multiSelect || !question.options[index]) return null;
  const input =
    typeof card.request.input === "object" && card.request.input ? card.request.input : {};
  return {
    behavior: "allow",
    updatedInput: {
      ...input,
      answers: buildAnswers(questions, new Map([[0, new Set([index])]]), new Map()),
    },
  };
}

export function permissionResponse(
  card: InboxCard,
  behavior: "allow" | "deny",
): PermissionResponse | null {
  if (card.reason !== "permission" || !card.request) return null;
  const action = card.request.actions?.find((candidate) => candidate.behavior === behavior);
  if (behavior === "allow") {
    return action ? { behavior: "allow", selectedActionId: action.id } : { behavior: "allow" };
  }
  return action
    ? { behavior: "deny", selectedActionId: action.id, message: "Denied from Inbox" }
    : { behavior: "deny", message: "Denied from Inbox" };
}

export interface BoardKeyState {
  ordered: readonly InboxCard[];
  focusedId: string | null;
  openCardId: string | null;
}

export type BoardKeyEffect =
  | { kind: "focus"; agentId: string | null }
  | { kind: "open"; agentId: string }
  | { kind: "close" }
  | {
      kind: "respond";
      card: InboxCard;
      response: PermissionResponse;
      /** Where focus goes after answering, so it does not follow the card into Done. */
      nextFocusAgentId: string | null;
    }
  | null;

function nextIndex(length: number, current: number, delta: 1 | -1): number {
  if (current < 0) return delta > 0 ? 0 : length - 1;
  return (current + delta + length) % length;
}

function resolveAnswer(
  action: Extract<KeyAction, { kind: "option" | "allow" | "deny" }>,
  focused: InboxCard | null,
  nextFocusAgentId: string | null,
): BoardKeyEffect {
  if (!focused?.request) return null;
  if (action.kind === "option") {
    const response = optionResponse(focused, action.index);
    return response
      ? { kind: "respond", card: focused, response, nextFocusAgentId }
      : { kind: "open", agentId: focused.agent.id };
  }
  const response = permissionResponse(focused, action.kind);
  return response ? { kind: "respond", card: focused, response, nextFocusAgentId } : null;
}

/** Turns a key action plus the board's current state into one effect. Pure, so it is testable. */
export function resolveKeyAction(action: KeyAction, state: BoardKeyState): BoardKeyEffect {
  const { ordered, focusedId, openCardId } = state;
  const focusedIndex = ordered.findIndex((card) => card.agent.id === focusedId);
  const focused = focusedIndex >= 0 ? ordered[focusedIndex] : null;
  switch (action.kind) {
    case "move": {
      if (ordered.length === 0) return null;
      const index = nextIndex(ordered.length, focusedIndex, action.delta);
      return { kind: "focus", agentId: ordered[index].agent.id };
    }
    case "open": {
      const target = focused ?? ordered[0];
      return target ? { kind: "open", agentId: target.agent.id } : null;
    }
    case "close":
      return openCardId ? { kind: "close" } : { kind: "focus", agentId: null };
    default:
      return resolveAnswer(
        action,
        focused,
        (ordered[focusedIndex + 1] ?? ordered[focusedIndex - 1])?.agent.id ?? null,
      );
  }
}

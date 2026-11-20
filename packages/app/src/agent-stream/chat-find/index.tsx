import type { ChatFindProps, ChatFindExpansionProps } from "./types";

export function ChatFind({ children }: ChatFindProps) {
  return children;
}
export function ChatFindExpansion({ children }: ChatFindExpansionProps) {
  return children(false);
}
/** Native has no chat find, so no message is ever selected by one. */
export function useChatFindSelectedMessageId(): string | null {
  return null;
}

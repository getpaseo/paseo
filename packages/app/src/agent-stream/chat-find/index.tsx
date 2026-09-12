import type { ChatFindProps, ChatFindExpansionProps } from "./types";

export function ChatFind({ children }: ChatFindProps) {
  return children;
}
export function ChatFindExpansion({ children }: ChatFindExpansionProps) {
  return children(false);
}

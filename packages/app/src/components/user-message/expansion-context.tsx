import { createContext, useCallback, useContext, useState, useSyncExternalStore } from "react";
import { createUserMessageExpansion, type UserMessageExpansion } from "./expansion";

export const UserMessageExpansionContext = createContext<UserMessageExpansion | null>(null);

/** One store per viewed agent; switching agents starts with every message collapsed. */
export function useAgentUserMessageExpansion(agentId: string): UserMessageExpansion {
  const [owner, setOwner] = useState(() => ({
    agentId,
    expansion: createUserMessageExpansion(),
  }));
  if (owner.agentId === agentId) return owner.expansion;
  const next = { agentId, expansion: createUserMessageExpansion() };
  setOwner(next);
  return next.expansion;
}

/** Subscribes one message to its own expanded state. */
export function useUserMessageExpanded(itemId: string) {
  const expansion = useContext(UserMessageExpansionContext);
  if (!expansion) throw new Error("MessagePreview requires a UserMessageExpansionContext");
  const subscribe = useCallback(
    (listener: () => void) => expansion.subscribe(itemId, listener),
    [expansion, itemId],
  );
  const getSnapshot = useCallback(() => expansion.isExpanded(itemId), [expansion, itemId]);
  const expanded = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const toggle = useCallback(() => expansion.toggle(itemId), [expansion, itemId]);
  return { expanded, toggle };
}

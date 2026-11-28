import { useSyncExternalStore } from "react";
import { composerPlaceholderStore } from "./store";

export function useComposerPlaceholder(serverId: string, agentId: string): string | null {
  return useSyncExternalStore(
    composerPlaceholderStore.subscribe,
    () => composerPlaceholderStore.textFor(serverId, agentId),
    () => null,
  );
}

import { createContext, useCallback, useContext, useState, useSyncExternalStore } from "react";
import type { ContextBridge } from "@/components/ui/isolated-bottom-sheet-modal";
import {
  createToolCallExpansion,
  type ExpandedToolCallGroups,
  type ToolCallExpansion,
} from "./expansion";

export const ToolCallExpansionContext = createContext<ToolCallExpansion | null>(null);

/** One store per viewed agent; switching agents starts with every tool call closed. */
export function useAgentToolCallExpansion(agentId: string): ToolCallExpansion {
  const [owner, setOwner] = useState(() => ({ agentId, expansion: createToolCallExpansion() }));
  if (owner.agentId === agentId) return owner.expansion;
  const next = { agentId, expansion: createToolCallExpansion() };
  setOwner(next);
  return next.expansion;
}

/** Subscribes the timeline to group toggles only; call toggles never reach it. */
export function useExpandedToolCallGroups(expansion: ToolCallExpansion): ExpandedToolCallGroups {
  return useSyncExternalStore(
    expansion.subscribeGroups,
    expansion.getExpandedGroups,
    expansion.getExpandedGroups,
  );
}

function useToolCallExpansion(): ToolCallExpansion {
  const expansion = useContext(ToolCallExpansionContext);
  if (!expansion) throw new Error("ToolCall requires a ToolCallExpansionContext");
  return expansion;
}

/** Carries tool call open state into sheets that render their content in a portal. */
export function useToolCallExpansionContextBridge(): ContextBridge {
  const expansion = useToolCallExpansion();
  return useCallback(
    (children) => (
      <ToolCallExpansionContext.Provider value={expansion}>
        {children}
      </ToolCallExpansionContext.Provider>
    ),
    [expansion],
  );
}

/** Subscribes one tool call to its own open state. */
export function useToolCallExpanded(input: {
  callId: string;
  defaultExpanded: boolean;
  standalone: boolean;
}) {
  const expansion = useToolCallExpansion();
  const { callId, defaultExpanded, standalone } = input;
  const subscribe = useCallback(
    (listener: () => void) => expansion.subscribeCall(callId, listener),
    [expansion, callId],
  );
  const getSnapshot = useCallback(
    () => expansion.isCallExpanded(callId, defaultExpanded),
    [expansion, callId, defaultExpanded],
  );
  const expanded = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const toggle = useCallback(() => {
    expansion.setCallExpanded({ callId, expanded: !expanded, standalone });
  }, [expansion, callId, expanded, standalone]);
  return { expanded, toggle };
}

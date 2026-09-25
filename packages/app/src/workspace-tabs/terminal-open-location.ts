import type { TerminalOpenLocation } from "@/hooks/use-settings";
import {
  useWorkspaceLayoutStore,
  type WorkspaceTabPlacement,
} from "@/stores/workspace-layout-store";

/** The destination a terminal creation arrived with, structurally matching TerminalTabDestination. */
export type TerminalCreationDestination =
  | { kind: "open"; paneId?: string }
  | { kind: "replace"; tabId: string };

interface ResolveImplicitTerminalPlacementInput {
  isCompact: boolean;
  supportsPaneSplits: boolean;
  persistenceKey: string | null;
  location: TerminalOpenLocation;
  destination: TerminalCreationDestination;
}

/**
 * Where an implicitly opened terminal lands, per the Open location preference.
 * An explicit pane target always wins; every other non-desktop context falls back
 * to the focused pane, which callers apply when this returns undefined.
 */
export function resolveImplicitTerminalPlacement(
  input: ResolveImplicitTerminalPlacementInput,
): WorkspaceTabPlacement | undefined {
  if (
    input.isCompact ||
    !input.supportsPaneSplits ||
    !input.persistenceKey ||
    input.destination.kind !== "open" ||
    input.destination.paneId
  ) {
    return undefined;
  }
  const store = useWorkspaceLayoutStore.getState();
  if (input.location === "bottom") {
    const paneId = store.ensureBottomPane(input.persistenceKey);
    return paneId ? { mode: "prefer", paneId } : undefined;
  }
  if (input.location === "side") {
    const paneId = store.ensureSidePane(input.persistenceKey);
    return paneId ? { mode: "prefer", paneId } : undefined;
  }
  return undefined;
}

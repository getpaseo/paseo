import { create } from "zustand";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";

/**
 * The live provider/model selection of a not-yet-started draft agent tab lives in the
 * composer's local form state (`useAgentFormState`), which is not reachable from global
 * components. The focused draft publishes a small controller here so the global Command
 * Center can list every provider's models and write a (provider, model) choice back into
 * the draft. Only the currently focused draft registers; it clears on blur/unmount.
 */
export interface FocusedDraftController {
  serverId: string;
  workspaceId: string;
  tabId: string;
  cwd: string;
  /** Currently selected provider (a fresh draft may still resolve to a default). */
  provider: AgentProvider | null;
  /** Currently effective model id (used only to mark the active row). */
  selectedModelId: string | null;
  setProviderAndModel: (provider: AgentProvider, modelId: string) => void;
}

interface FocusedDraftControllerState {
  controller: FocusedDraftController | null;
  setController: (controller: FocusedDraftController) => void;
  /** Clears only if `tabId` still owns the slot, so a newly focused draft isn't wiped. */
  clearController: (tabId: string) => void;
}

export const useFocusedDraftControllerStore = create<FocusedDraftControllerState>((set) => ({
  controller: null,
  setController: (controller) => set({ controller }),
  clearController: (tabId) =>
    set((state) => (state.controller?.tabId === tabId ? { controller: null } : state)),
}));

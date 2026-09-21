import { create } from "zustand";

interface AgentViewStoreState {
  selectedViews: Record<string, "chat" | "artifacts">;
  setSelectedView: (serverId: string, agentId: string, view: "chat" | "artifacts") => void;
  getSelectedView: (serverId: string, agentId: string) => "chat" | "artifacts";
}

export const useAgentViewStore = create<AgentViewStoreState>()((set, get) => ({
  selectedViews: {},
  setSelectedView: (serverId, agentId, view) => {
    set((state) => ({
      selectedViews: {
        ...state.selectedViews,
        [`${serverId}:${agentId}`]: view,
      },
    }));
  },
  getSelectedView: (serverId, agentId) => {
    return get().selectedViews[`${serverId}:${agentId}`] || "chat";
  },
}));

import { create } from "zustand";

interface AgentViewStoreState {
  selectedViews: Record<string, "chat" | "artifacts" | "find">;
  setSelectedView: (serverId: string, agentId: string, view: "chat" | "artifacts" | "find") => void;
  getSelectedView: (serverId: string, agentId: string) => "chat" | "artifacts" | "find";
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

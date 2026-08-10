import { create } from "zustand";

/**
 * Opens the global "Add backlog task" sheet without navigating to /backlog.
 * Optional host/project pre-select when the user started from a project row.
 */
export interface CreateBacklogTaskRequest {
  preferredServerId?: string;
  preferredProjectId?: string;
  preferredProjectName?: string;
}

interface CreateBacklogTaskState {
  request: CreateBacklogTaskRequest | null;
  openCreateBacklogTask: (request?: CreateBacklogTaskRequest) => void;
  closeCreateBacklogTask: () => void;
}

export const useCreateBacklogTaskStore = create<CreateBacklogTaskState>((set) => ({
  request: null,
  openCreateBacklogTask: (request = {}) => set({ request }),
  closeCreateBacklogTask: () => set({ request: null }),
}));

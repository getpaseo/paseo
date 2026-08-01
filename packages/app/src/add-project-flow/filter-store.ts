import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { AddProjectSourceFilter } from "./options";

interface AddProjectFilterStoreState {
  /** Explicit per-host selections only. Absent key = "all" (the default). */
  filterByHost: Record<string, AddProjectSourceFilter>;
  setHostFilter: (hostId: string, filter: AddProjectSourceFilter) => void;
}

/**
 * Per-host sticky source filter for the unified Add Project search. Only
 * explicit non-default selections are persisted — choosing "all" removes the
 * stored preference so the default can never stomp a host that was never
 * customized, and a stored filter always reflects a deliberate user choice.
 */
export const useAddProjectFilterStore = create<AddProjectFilterStoreState>()(
  persist(
    (set) => ({
      filterByHost: {},
      setHostFilter: (hostId, filter) =>
        set((state) => {
          const filterByHost = { ...state.filterByHost };
          if (filter === "all") {
            delete filterByHost[hostId];
          } else {
            filterByHost[hostId] = filter;
          }
          return { filterByHost };
        }),
    }),
    {
      name: "add-project-source-filter",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ filterByHost: state.filterByHost }),
    },
  ),
);

export function readAddProjectSourceFilter(
  filterByHost: Record<string, AddProjectSourceFilter>,
  hostId: string | null,
): AddProjectSourceFilter {
  if (!hostId) return "all";
  return filterByHost[hostId] ?? "all";
}

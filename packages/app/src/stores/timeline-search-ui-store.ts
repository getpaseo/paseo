import { create } from "zustand";
import type { TimelineSearchFilter } from "@/timeline-search/timeline-search-model";

/**
 * Persists the timeline search find-panel's UI state (isOpen/query/filter)
 * per search scope (server+agent), in memory only, so the panel survives an
 * `AgentStreamView` remount for the SAME scope — e.g. when a layout breakpoint
 * flip (compact <-> desktop) remounts the view and would otherwise reset the
 * panel via `useTimelineSearchModel`'s resetKey semantics.
 *
 * Intentionally NOT persisted to disk: this is transient view state, not a
 * user preference, and it must not leak across app restarts or sessions.
 */
export interface TimelineSearchUiSnapshot {
  isOpen: boolean;
  query: string;
  filter: TimelineSearchFilter;
}

interface TimelineSearchUiState {
  // Keyed by the search scope (server+agent), not agent id alone — see
  // useTimelineSearchModel's resetKey. Snapshots are tiny ({isOpen, query,
  // filter}); the map grows by one entry per distinct scope visited in a
  // session, which is negligible and intentionally not evicted.
  snapshotByKey: Record<string, TimelineSearchUiSnapshot>;
  setSnapshot: (key: string, snapshot: TimelineSearchUiSnapshot) => void;
}

export const useTimelineSearchUiStore = create<TimelineSearchUiState>((set) => ({
  snapshotByKey: {},
  setSnapshot: (key, snapshot) =>
    set((state) => {
      const existing = state.snapshotByKey[key];
      if (
        existing &&
        existing.isOpen === snapshot.isOpen &&
        existing.query === snapshot.query &&
        existing.filter === snapshot.filter
      ) {
        return state;
      }
      return {
        snapshotByKey: { ...state.snapshotByKey, [key]: snapshot },
      };
    }),
}));

export function getTimelineSearchSnapshot(key: string): TimelineSearchUiSnapshot | undefined {
  return useTimelineSearchUiStore.getState().snapshotByKey[key];
}

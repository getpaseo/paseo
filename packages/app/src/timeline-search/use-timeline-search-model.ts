import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { StreamItem } from "@/types/stream";
import {
  getTimelineSearchSnapshot,
  useTimelineSearchUiStore,
} from "@/stores/timeline-search-ui-store";
import { createTimelineSearchModel, type TimelineSearchModel } from "./timeline-search-model";

export interface UseTimelineSearchModelResult {
  state: ReturnType<TimelineSearchModel["getState"]>;
  model: TimelineSearchModel;
}

/**
 * React binding for the pure timeline search model. `getItems` is read
 * through a ref so callers can pass a fresh closure on every render without
 * tearing down search state (query/filter/selection survive item updates).
 *
 * `resetKey` recreates the model (fresh query/filter/matches/isOpen) when it
 * changes — pass the identity of whatever this search is scoped to (e.g. an
 * agent id) so retargeting a tab to a different agent doesn't leak the
 * previous agent's open search panel and stale matches into the new one.
 *
 * When `resetKey` is provided, the panel's `isOpen`/`query`/`filter` are also
 * mirrored to `useTimelineSearchUiStore`, keyed by `resetKey`. A freshly
 * created model is seeded from that store, so a REMOUNT for the same
 * `resetKey` (e.g. an `AgentStreamView` remount triggered by a compact/desktop
 * breakpoint flip) restores the open panel and its query instead of resetting
 * it. Retargeting to a different `resetKey` still starts clean, since the
 * seed lookup is scoped to the new key and the old key's stored state is
 * simply not read.
 */
export function useTimelineSearchModel(
  getItems: () => readonly StreamItem[],
  resetKey?: string,
): UseTimelineSearchModelResult {
  const getItemsRef = useRef(getItems);
  getItemsRef.current = getItems;

  const model = useMemo(() => {
    const created = createTimelineSearchModel(() => getItemsRef.current());
    if (resetKey) {
      const snapshot = getTimelineSearchSnapshot(resetKey);
      if (snapshot) {
        created.setFilter(snapshot.filter);
        created.setQuery(snapshot.query);
        if (snapshot.isOpen) {
          created.open();
        }
      }
    }
    return created;
    // getItemsRef always reads the latest closure; only resetKey should
    // recreate the model.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);

  useEffect(() => {
    if (!resetKey) return;
    const setSnapshot = useTimelineSearchUiStore.getState().setSnapshot;
    const writeSnapshot = () => {
      const current = model.getState();
      setSnapshot(resetKey, {
        isOpen: current.isOpen,
        query: current.query,
        filter: current.filter,
      });
    };
    writeSnapshot();
    return model.subscribe(writeSnapshot);
  }, [resetKey, model]);

  return { state, model };
}

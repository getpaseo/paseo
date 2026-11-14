import {
  moveActiveResultId,
  preserveActiveResultId,
  type CommandCenterListProjection,
} from "./results";
import type { CommandCenterTab } from "./tabs";

interface Snapshot {
  query: string;
  activeId: string | null;
}

interface ResultsInput {
  open: boolean;
  tab: CommandCenterTab;
  query: string;
  projection: CommandCenterListProjection;
  loading: boolean;
}

/**
 * Until the user moves the selection it is the first result, wherever results land. Once they
 * move it, their pick persists. Permission to move the viewport lasts for one user command.
 */
export function createCommandCenterInteraction(scrollToOffset: (offset: number) => void) {
  let snapshot: Snapshot = { query: "", activeId: null };
  const listeners = new Set<() => void>();
  let open = false;
  let tab: CommandCenterTab = "all";
  let projection: CommandCenterListProjection | null = null;
  let loading = false;
  let revealPending = false;
  let userPicked = false;
  let offset = 0;
  let visibleLength = 0;

  function publish(next: Snapshot) {
    if (next.query === snapshot.query && next.activeId === snapshot.activeId) return;
    snapshot = next;
    for (const listener of listeners) listener();
  }

  function reveal() {
    if (!open || !revealPending || !projection || visibleLength <= 0) return;
    // The Files tab keeps its previous entries while the next query is loading.
    if (tab === "files" && loading) return;
    if (!snapshot.activeId) {
      if (!loading) revealPending = false;
      return;
    }
    const index = projection.rowIndexByResultId.get(snapshot.activeId);
    if (index === undefined) return;
    const top = projection.offsets[index];
    const bottom = top + projection.rows[index].height;
    revealPending = false;
    let nextOffset = offset;
    if (top < offset) nextOffset = top;
    if (bottom > offset + visibleLength) nextOffset = bottom - visibleLength;
    nextOffset = Math.max(0, nextOffset);
    if (nextOffset === offset) return;
    offset = nextOffset;
    scrollToOffset(nextOffset);
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update(input: ResultsInput) {
      const tabChanged = open && input.open && tab !== input.tab;
      const resetSelection = input.open && (!open || tabChanged);
      open = input.open;
      tab = input.tab;
      if (!open) {
        projection = null;
        revealPending = false;
        offset = 0;
        visibleLength = 0;
        publish({ query: "", activeId: null });
        return;
      }
      if (resetSelection) {
        revealPending = true;
        userPicked = false;
        publish({ ...snapshot, activeId: null });
      }
      // A tab is a different list: it starts at its top, section label included.
      if (tabChanged && offset !== 0) {
        offset = 0;
        scrollToOffset(0);
      }
      // A query command invalidates the old projection until React supplies its new results.
      if (input.query !== snapshot.query) return;
      projection = input.projection;
      loading = input.loading;
      if (tab !== "files" || !loading) {
        publish({
          ...snapshot,
          activeId: userPicked
            ? preserveActiveResultId(snapshot.activeId, projection.selectableResults)
            : (projection.selectableResults[0]?.id ?? null),
        });
      }
      reveal();
    },
    setQuery(query: string) {
      projection = null;
      revealPending = true;
      userPicked = false;
      publish({ query, activeId: null });
    },
    move(direction: "next" | "previous"): boolean {
      if (
        !open ||
        !projection ||
        (tab === "files" && loading) ||
        projection.selectableResults.length === 0
      )
        return false;
      userPicked = true;
      publish({
        ...snapshot,
        activeId: moveActiveResultId(snapshot.activeId, projection.selectableResults, direction),
      });
      revealPending = true;
      reveal();
      return true;
    },
    layout(height: number) {
      visibleLength = height;
      reveal();
    },
    scrolled(nextOffset: number) {
      offset = nextOffset;
    },
    beginManualScroll() {
      revealPending = false;
    },
  };
}

export type CommandCenterInteraction = ReturnType<typeof createCommandCenterInteraction>;

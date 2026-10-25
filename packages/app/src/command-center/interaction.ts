import type { CommandCenterScope } from "@/stores/keyboard-shortcuts-store";
import {
  moveActiveResultId,
  preserveActiveResultId,
  type CommandCenterListProjection,
} from "./results";

interface Snapshot {
  query: string;
  activeId: string | null;
}

interface ResultsInput {
  open: boolean;
  scope: CommandCenterScope;
  query: string;
  projection: CommandCenterListProjection;
  loading: boolean;
}

/** Selection persists; permission to move the viewport lasts for one user command. */
export function createCommandCenterInteraction(scrollToOffset: (offset: number) => void) {
  let snapshot: Snapshot = { query: "", activeId: null };
  const listeners = new Set<() => void>();
  let open = false;
  let scope: CommandCenterScope = null;
  let projection: CommandCenterListProjection | null = null;
  let loading = false;
  let revealPending = false;
  let offset = 0;
  let visibleLength = 0;

  function publish(next: Snapshot) {
    if (next.query === snapshot.query && next.activeId === snapshot.activeId) return;
    snapshot = next;
    for (const listener of listeners) listener();
  }

  function reveal() {
    if (!open || !revealPending || !projection || visibleLength <= 0) return;
    // Scoped file search keeps its previous entries while the next query is loading.
    if (scope === "files" && loading) return;
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
      const resetSelection = input.open && (!open || scope !== input.scope);
      open = input.open;
      scope = input.scope;
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
        publish({ ...snapshot, activeId: null });
      }
      // A query command invalidates the old projection until React supplies its new results.
      if (input.query !== snapshot.query) return;
      projection = input.projection;
      loading = input.loading;
      if (scope !== "files" || !loading) {
        publish({
          ...snapshot,
          activeId: preserveActiveResultId(snapshot.activeId, projection.selectableResults),
        });
      }
      reveal();
    },
    setQuery(query: string) {
      projection = null;
      revealPending = true;
      publish({ query, activeId: null });
    },
    move(direction: "next" | "previous"): boolean {
      if (
        !open ||
        !projection ||
        (scope === "files" && loading) ||
        projection.selectableResults.length === 0
      )
        return false;
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

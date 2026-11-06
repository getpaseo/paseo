import { useEffect } from "react";
import { create } from "zustand";

/** The identity triple every sidebar row carries, and the only thing selection needs. */
export interface SidebarSelectionTarget {
  serverId: string;
  workspaceId: string;
  workspaceKey: string;
}

interface SidebarSelectionSegment {
  id: string;
  /**
   * The section's visual position, supplied by the renderer (pinned = 0, then each group in
   * render order). Sections appear and disappear as statuses and filters change, so registration
   * order cannot be trusted to match what the user sees — the flat order sorts on this.
   */
  position: number;
  targets: readonly SidebarSelectionTarget[];
}

interface SidebarSelectionState {
  /**
   * The sidebar's rows in flat visual order — pinned section first, then each group's rows —
   * derived from the segments the mounted list renderer registers. Only rows that actually
   * render belong here: a Shift range must never reach past a "show more" boundary into rows
   * the user cannot see.
   */
  order: readonly SidebarSelectionTarget[];
  segments: readonly SidebarSelectionSegment[];
  selected: readonly SidebarSelectionTarget[];
  /** Derived set of selected keys, so a row can ask "am I in it" without scanning. */
  selectedKeys: ReadonlySet<string>;
  anchorKey: string | null;
  /** Registers (or replaces) one section's rendered rows at a visual position; an empty list keeps the slot but contributes no rows. */
  setSegment: (id: string, position: number, targets: readonly SidebarSelectionTarget[]) => void;
  removeSegment: (id: string) => void;
  /** Whole-order registration, for tests; production lists register segments. */
  setOrder: (order: readonly SidebarSelectionTarget[]) => void;
  handleSelectPress: (target: SidebarSelectionTarget, options: { range: boolean }) => void;
  /**
   * A plain press is a single selection: it navigates, replaces any multi-selection with just
   * this row, and moves the range anchor — so a Ctrl press after it adds to it and a Shift press
   * extends from it, the way file managers extend from the last-clicked row.
   */
  handleNavigatePress: (target: SidebarSelectionTarget) => void;
  /** Removes exactly these rows from the selection, leaving anything selected since alone. */
  deselect: (targets: readonly SidebarSelectionTarget[]) => void;
  clear: () => void;
}

export const emptySidebarSelectionTargetSet: ReadonlySet<string> = new Set();

/** The whole-order segment `setOrder` writes; exported for test isolation. */
export const WHOLE_ORDER_SEGMENT_ID = "__all__";

function toKeySet(targets: readonly SidebarSelectionTarget[]): ReadonlySet<string> {
  return new Set(targets.map((target) => target.workspaceKey));
}

/**
 * The order slice between two rows, inclusive. Pure so the range rule is testable without a
 * component: the anchor stays where it was (a shift press extends, it does not move it), and an
 * anchor that fell out of the visible order starts a fresh range at the pressed row.
 */
export function computeRangeSelection(
  order: readonly SidebarSelectionTarget[],
  anchorKey: string | null,
  targetKey: string,
): readonly SidebarSelectionTarget[] {
  const targetIndex = order.findIndex((target) => target.workspaceKey === targetKey);
  if (targetIndex < 0) return [];
  const anchorIndex =
    anchorKey !== null ? order.findIndex((target) => target.workspaceKey === anchorKey) : -1;
  if (anchorIndex < 0) return order.filter((target) => target.workspaceKey === targetKey);
  const start = Math.min(anchorIndex, targetIndex);
  const end = Math.max(anchorIndex, targetIndex);
  return order.slice(start, end + 1);
}

/** Cmd/Ctrl click: press a selected row to drop it, press anything else to add it. */
export function computeToggleSelection(
  selected: readonly SidebarSelectionTarget[],
  target: SidebarSelectionTarget,
): { selected: readonly SidebarSelectionTarget[]; removed: boolean } {
  if (selected.some((entry) => entry.workspaceKey === target.workspaceKey)) {
    return {
      selected: selected.filter((entry) => entry.workspaceKey !== target.workspaceKey),
      removed: true,
    };
  }
  return { selected: [...selected, target], removed: false };
}

export const useSidebarSelectionStore = create<SidebarSelectionState>((set, get) => {
  // Recomputes the derived order from the registered segments, sorted by each section's visual
  // position. Selection and anchor are deliberately untouched here: a section updating its rows
  // ("show more", a collapse, a re-render with fresh objects) must never erase what the user
  // already selected — batch actions resolve each selected row against live state and skip rows
  // that are gone.
  function applySegments(segments: readonly SidebarSelectionSegment[]): void {
    const previous = get().segments;
    if (previous === segments) {
      return;
    }
    const order = [...segments]
      .sort((left, right) => left.position - right.position)
      .flatMap((segment) => segment.targets);
    set({ segments, order });
  }

  return {
    order: [],
    segments: [],
    selected: [],
    selectedKeys: emptySidebarSelectionTargetSet,
    anchorKey: null,
    setSegment: (id, position, targets) => {
      const existing = get().segments;
      const current = existing.find((segment) => segment.id === id);
      // Same reference and position: nothing rendered differently, so do not touch derived state.
      if (current && current.targets === targets && current.position === position) {
        return;
      }
      // An existing slot updates in place, so a section that disappears and comes back (a status
      // group appearing again, a collapsed group reopening) lands in its own visual position
      // rather than at the end; only genuinely new sections join the list.
      applySegments(
        current
          ? existing.map((segment) => (segment.id === id ? { id, position, targets } : segment))
          : [...existing, { id, position, targets }],
      );
    },
    removeSegment: (id) => {
      // Unmount only (a mode switch, a filter that unrenders the section). Row changes go
      // through setSegment's in-place update, which keeps both the slot and the selection.
      const existing = get().segments;
      if (!existing.some((segment) => segment.id === id)) {
        return;
      }
      applySegments(existing.filter((segment) => segment.id !== id));
    },
    setOrder: (order) => {
      get().setSegment(WHOLE_ORDER_SEGMENT_ID, 0, order);
    },
    handleSelectPress: (target, { range }) => {
      const { order, anchorKey, selected } = get();
      if (range) {
        const anchor =
          anchorKey !== null && order.some((entry) => entry.workspaceKey === anchorKey)
            ? anchorKey
            : target.workspaceKey;
        const next = computeRangeSelection(order, anchor, target.workspaceKey);
        set({ selected: next, selectedKeys: toKeySet(next), anchorKey: anchor });
        return;
      }
      const { selected: next, removed } = computeToggleSelection(selected, target);
      set({
        selected: next,
        selectedKeys: toKeySet(next),
        anchorKey: removed && next.length === 0 ? null : target.workspaceKey,
      });
    },
    handleNavigatePress: (target) =>
      // A plain press is a single selection: it navigates and resets whatever multi-selection was
      // building to just this row, which is then the base a Ctrl press adds to and a Shift press
      // extends from — the file-manager flow.
      set({
        selected: [target],
        selectedKeys: toKeySet([target]),
        anchorKey: target.workspaceKey,
      }),
    deselect: (targets) => {
      // Removes exactly these rows — a batch action that finished while the user was selecting
      // more rows must not erase the newer additions.
      const keys = toKeySet(targets);
      const { selected, anchorKey } = get();
      const next = selected.filter((target) => !keys.has(target.workspaceKey));
      set({
        selected: next,
        selectedKeys: toKeySet(next),
        anchorKey: anchorKey !== null && !keys.has(anchorKey) ? anchorKey : null,
      });
    },
    clear: () =>
      set({ selected: [], selectedKeys: emptySidebarSelectionTargetSet, anchorKey: null }),
  };
});

/**
 * Registers one list section's rendered rows (a pinned section, a group, a project block) under
 * a stable id at the section's visual position. Row updates replace the section's rows in
 * place — the slot, its position, and the selection survive "show more", collapses, and
 * re-renders — and only unmounting the section removes it.
 */
export function useSidebarSelectionSegment(
  id: string,
  position: number,
  targets: readonly SidebarSelectionTarget[],
): void {
  useEffect(() => {
    useSidebarSelectionStore.getState().setSegment(id, position, targets);
    return () => {
      useSidebarSelectionStore.getState().removeSegment(id);
    };
  }, [id, position, targets]);
}

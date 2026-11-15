import { useCallback, useReducer } from "react";
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import { dragStateInitial, dragStateReducer } from "./drag-reducer";
import { reorderItemsOnDragEnd } from "./reorder-items";

export interface DragReorderHandlers {
  onDragStart: (event: DragStartEvent) => void;
  onDragCancel: () => void;
  onDragEnd: (event: DragEndEvent) => void;
}

export interface DragReorderState<T> {
  activeId: string | null;
  items: T[];
  handlers: DragReorderHandlers;
}

function haveSameOrder<T>(
  left: T[],
  right: T[],
  keyExtractor: (item: T, index: number) => string,
): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => keyExtractor(item, index) === keyExtractor(right[index], index))
  );
}

export function useDragReorderState<T>({
  data,
  keyExtractor,
  onDragEnd,
  onDragBegin,
  disabled = false,
}: {
  data: T[];
  keyExtractor: (item: T, index: number) => string;
  onDragEnd?: (items: T[], movedKey: string) => void;
  onDragBegin?: () => void;
  disabled?: boolean;
}): DragReorderState<T> {
  const [state, dispatch] = useReducer(dragStateReducer<T>, undefined, dragStateInitial<T>);

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      if (disabled) return;
      dispatch({ type: "start", id: String(event.active.id), data });
      onDragBegin?.();
    },
    [data, disabled, onDragBegin],
  );

  const clearDragState = useCallback(() => {
    dispatch({ type: "clear" });
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      const activeId = String(active.id);
      const reordered = disabled
        ? null
        : reorderItemsOnDragEnd({
            items: state.dragItems ?? data,
            activeId,
            overId: over ? String(over.id) : null,
            keyExtractor,
          });
      if (!reordered) {
        dispatch({ type: "clear" });
        return;
      }
      // The owner's new order can arrive in a later render. Hold the dropped order until it does.
      dispatch({ type: "drop", items: reordered, replaces: data });
      onDragEnd?.(reordered, activeId);
    },
    [data, disabled, keyExtractor, onDragEnd, state.dragItems],
  );

  const ownerReordered =
    state.replaces !== null && !haveSameOrder(state.replaces, data, keyExtractor);
  if (ownerReordered) dispatch({ type: "clear" });

  return {
    activeId: state.activeId,
    items: ownerReordered ? data : (state.dragItems ?? data),
    handlers: {
      onDragStart: handleDragStart,
      onDragCancel: clearDragState,
      onDragEnd: handleDragEnd,
    },
  };
}

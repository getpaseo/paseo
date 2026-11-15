/** A dropped key order, shown in place of the owner's until the owner's order changes. */
export interface DroppedOrder {
  order: string[];
  /** The owner's key order at the drop. */
  replaces: string[];
}

export interface DragState<T> {
  activeId: string | null;
  /** The rows on screen while a drag is in flight. */
  dragItems: T[] | null;
  dropped: DroppedOrder | null;
}

export type DragAction<T> =
  | { type: "start"; id: string; items: T[] }
  | { type: "drop"; dropped: DroppedOrder }
  | { type: "clear" };

export function dragStateInitial<T>(): DragState<T> {
  return { activeId: null, dragItems: null, dropped: null };
}

export function dragStateReducer<T>(state: DragState<T>, action: DragAction<T>): DragState<T> {
  switch (action.type) {
    case "start":
      return { activeId: action.id, dragItems: action.items, dropped: null };
    case "drop":
      return { activeId: null, dragItems: null, dropped: action.dropped };
    case "clear":
      return dragStateInitial();
  }
}

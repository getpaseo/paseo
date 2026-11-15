export interface DragState<T> {
  activeId: string | null;
  /** The order on screen while it differs from the owner's data: frozen during a drag, held after a drop. */
  dragItems: T[] | null;
  /** After a drop, the owner's data that `dragItems` stands in for until the owner reorders it. */
  replaces: T[] | null;
}

export type DragAction<T> =
  | { type: "start"; id: string; data: T[] }
  | { type: "drop"; items: T[]; replaces: T[] }
  | { type: "clear" };

export function dragStateInitial<T>(): DragState<T> {
  return { activeId: null, dragItems: null, replaces: null };
}

export function dragStateReducer<T>(state: DragState<T>, action: DragAction<T>): DragState<T> {
  switch (action.type) {
    case "start":
      return { activeId: action.id, dragItems: action.data, replaces: null };
    case "drop":
      return { activeId: null, dragItems: action.items, replaces: action.replaces };
    case "clear":
      return dragStateInitial();
  }
}

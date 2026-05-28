export interface DragState<T> {
  activeId: string | null;
  dragItems: T[] | null;
}

export type DragAction<T> = { type: "start"; id: string; data: T[] } | { type: "clear" };

export function dragStateInitial<T>(): DragState<T> {
  return { activeId: null, dragItems: null };
}

export function dragStateReducer<T>(state: DragState<T>, action: DragAction<T>): DragState<T> {
  switch (action.type) {
    case "start":
      return { activeId: action.id, dragItems: action.data };
    case "clear":
      return { activeId: null, dragItems: null };
  }
}

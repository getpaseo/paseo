import { arrayMove } from "@dnd-kit/sortable";

export interface DragEndInput<T> {
  items: T[];
  activeId: string;
  overId: string | null | undefined;
  keyExtractor: (item: T, index: number) => string;
}

export function reorderItemsOnDragEnd<T>({
  items,
  activeId,
  overId,
  keyExtractor,
}: DragEndInput<T>): T[] | null {
  if (!overId || activeId === overId) return null;

  const oldIndex = items.findIndex((item, i) => keyExtractor(item, i) === activeId);
  const newIndex = items.findIndex((item, i) => keyExtractor(item, i) === overId);

  if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return null;

  return arrayMove(items, oldIndex, newIndex);
}

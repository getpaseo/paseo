import type { ReactElement } from "react";
import type { DraggableRenderItemInfo } from "./draggable-list.types";

export function SortableInlineList<T>({
  data,
  keyExtractor,
  renderItem,
}: {
  data: T[];
  keyExtractor: (item: T, index: number) => string;
  renderItem: (info: DraggableRenderItemInfo<T>) => ReactElement;
  onDragEnd?: (data: T[]) => void;
  useDragHandle?: boolean;
  disabled?: boolean;
  externalDndContext?: boolean;
  activeId?: string | null;
  getItemData?: (item: T, index: number) => Record<string, unknown>;
  orientation?: "horizontal" | "vertical";
}): ReactElement {
  return (
    <>
      {data.map((item, index) => {
        const id = keyExtractor(item, index);
        return (
          <SortableInlineListItem key={id} item={item} index={index} renderItem={renderItem} />
        );
      })}
    </>
  );
}

function SortableInlineListItem<T>({
  item,
  index,
  renderItem,
}: {
  item: T;
  index: number;
  renderItem: (info: DraggableRenderItemInfo<T>) => ReactElement;
}): ReactElement {
  const info: DraggableRenderItemInfo<T> = {
    item,
    index,
    drag: () => {},
    isActive: false,
  };
  return renderItem(info);
}

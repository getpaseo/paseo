import { View } from "react-native";
import { useCallback, type MutableRefObject, type ReactElement } from "react";
import type { GestureType } from "react-native-gesture-handler";
import { DraggableList, type DraggableRenderItemInfo } from "../draggable-list";
import type { DraggableListDragHandleProps } from "../draggable-list.types";

export interface SidebarWorkspaceSectionRowInput {
  drag?: () => void;
  isDragging?: boolean;
  dragHandleProps?: DraggableListDragHandleProps;
}

interface SidebarWorkspaceSectionRowsProps<T> {
  testID: string;
  /**
   * The open workspace when the row limit hides it. It renders above the list, outside the drag
   * list, because the list only holds the rows the limit kept and a drag would otherwise start
   * from a row the limit hides.
   */
  leadingItem: T | null;
  items: T[];
  /** Only manual sort hands rows to the drag list; the other sorts belong to the project. */
  manualSort: boolean;
  keyExtractor: (item: T) => string;
  renderRow: (item: T, input?: SidebarWorkspaceSectionRowInput) => ReactElement;
  onReorder: (items: T[]) => void;
  extraData: string;
  useNestable: boolean;
  parentGestureRef?: MutableRefObject<GestureType | undefined>;
  dragGestureHostActive?: boolean;
}

export function SidebarWorkspaceSectionRows<T>({
  testID,
  leadingItem,
  items,
  manualSort,
  keyExtractor,
  renderRow,
  onReorder,
  extraData,
  useNestable,
  parentGestureRef,
  dragGestureHostActive,
}: SidebarWorkspaceSectionRowsProps<T>) {
  const leadingRow = leadingItem ? renderRow(leadingItem) : null;
  const renderDraggableRow = useCallback(
    ({ item, drag, isActive, dragHandleProps }: DraggableRenderItemInfo<T>) =>
      renderRow(item, { drag, isDragging: isActive, dragHandleProps }),
    [renderRow],
  );

  if (!manualSort) {
    return (
      <View testID={testID}>
        {leadingRow}
        {items.map((item) => renderRow(item))}
      </View>
    );
  }

  return (
    <>
      {leadingRow}
      <DraggableList
        testID={testID}
        data={items}
        keyExtractor={keyExtractor}
        renderItem={renderDraggableRow}
        onDragEnd={onReorder}
        extraData={extraData}
        scrollEnabled={false}
        useDragHandle
        nestable={useNestable}
        simultaneousGestureRef={parentGestureRef}
        gestureHostPresented={dragGestureHostActive}
      />
    </>
  );
}

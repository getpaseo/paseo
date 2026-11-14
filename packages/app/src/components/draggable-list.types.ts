import type { MutableRefObject, PropsWithChildren, ReactElement } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import type { GestureType } from "react-native-gesture-handler";

/**
 * Marks the row a drag starts from when the list uses a drag handle. On web, spread
 * `attributes` and `listeners` and assign `setActivatorNodeRef` on the handle element. On
 * every platform, wrap the handle in `DraggableListHandle` with these props.
 */
export interface DraggableListDragHandleProps {
  attributes?: Record<string, unknown>;
  listeners?: Record<string, unknown>;
  setActivatorNodeRef?: (node: unknown) => void;
}

export interface DraggableRenderItemInfo<T> {
  item: T;
  index: number;
  isActive: boolean;
  dragHandleProps?: DraggableListDragHandleProps;
}

export interface DraggableListProps<T> {
  data: T[];
  keyExtractor: (item: T) => string;
  renderItem: (info: DraggableRenderItemInfo<T>) => ReactElement;
  onDragEnd: (data: T[]) => void;
  containerStyle?: StyleProp<ViewStyle>;
  testID?: string;
  /**
   * When true, a drag starts only from the `DraggableListHandle` that receives the row's
   * `dragHandleProps`, so a list nested inside a row keeps its own drags.
   */
  useDragHandle?: boolean;
}

export type DraggableListHandleProps = PropsWithChildren<{
  dragHandleProps: DraggableListDragHandleProps | undefined;
}>;

/** The vertical scroll view that hosts draggable lists and scrolls while a row is dragged. */
export type DraggableListScrollViewProps = PropsWithChildren<{
  style?: StyleProp<ViewStyle>;
  contentContainerStyle?: StyleProp<ViewStyle>;
  showsVerticalScrollIndicator?: boolean;
  testID?: string;
  /** Native-only: a gesture that keeps recognizing while the list scrolls, e.g. a panel close. */
  simultaneousGestureRef?: MutableRefObject<GestureType | undefined>;
}>;

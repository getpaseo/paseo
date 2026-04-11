import type { ReactElement, MutableRefObject } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import type { GestureType } from "react-native-gesture-handler";

export interface DraggableListDragHandleProps {
  /**
   * Web-only drag handle props (from dnd-kit). Spread these onto the element
   * that should initiate the drag. Native uses the `drag()` callback instead.
   */
  attributes?: Record<string, unknown>;
  listeners?: Record<string, unknown>;
  setActivatorNodeRef?: (node: unknown) => void;
}

export interface DraggableRenderItemInfo<T> {
  item: T;
  index: number;
  drag: () => void;
  isActive: boolean;
  dragHandleProps?: DraggableListDragHandleProps;
}

export interface DraggableListProps<T> {
  data: T[];
  keyExtractor: (item: T, index: number) => string;
  renderItem: (info: DraggableRenderItemInfo<T>) => ReactElement;
  onDragEnd: (data: T[]) => void;
  style?: StyleProp<ViewStyle>;
  /** Outer container style (useful for nested, non-scrolling lists). */
  containerStyle?: StyleProp<ViewStyle>;
  contentContainerStyle?: StyleProp<ViewStyle>;
  testID?: string;
  ListFooterComponent?: ReactElement | null;
  ListHeaderComponent?: ReactElement | null;
  ListEmptyComponent?: ReactElement | null;
  showsVerticalScrollIndicator?: boolean;
  enableDesktopWebScrollbar?: boolean;
  /** When false, disables internal scrolling (use outer list to scroll). */
  scrollEnabled?: boolean;
  /**
   * Web-only: when true, the drag can only be initiated from the handle props
   * passed to `renderItem` (prevents nested lists from fighting).
   */
  useDragHandle?: boolean;
  /**
   * Web-only: when > 0, requires press-and-hold before a drag starts.
   * Falls back to distance-based activation when omitted.
   */
  webLongPressDelayMs?: number;
  refreshing?: boolean;
  onRefresh?: () => void;
  /** Fill remaining space when content is smaller than container */
  contentContainerFlexGrow?: boolean;
  /** Gesture ref for simultaneous handling with parent gestures (e.g., sidebar close) */
  simultaneousGestureRef?: MutableRefObject<GestureType | undefined>;
  /** Gesture ref(s) that the list should wait for before handling scroll */
  waitFor?: MutableRefObject<GestureType | undefined> | MutableRefObject<GestureType | undefined>[];
  /** Called when a drag gesture begins (before items are reordered) */
  onDragBegin?: () => void;
  /** Called immediately before invoking row `drag()` to lock outer owners. */
  onDragIntent?: () => void;
  /** Called when drag interaction ends (finger released). */
  onDragRelease?: () => void;
  /**
   * Native-only: use the nestable draggable-flatlist variant for nested drag
   * lists coordinated by a shared NestableScrollContainer.
   */
  nestable?: boolean;
}

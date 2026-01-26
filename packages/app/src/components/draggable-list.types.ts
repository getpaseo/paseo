import type { ReactElement, MutableRefObject } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import type { GestureType } from "react-native-gesture-handler";

export interface DraggableRenderItemInfo<T> {
  item: T;
  index: number;
  drag: () => void;
  isActive: boolean;
}

export interface DraggableListProps<T> {
  data: T[];
  keyExtractor: (item: T, index: number) => string;
  renderItem: (info: DraggableRenderItemInfo<T>) => ReactElement;
  onDragEnd: (data: T[]) => void;
  style?: StyleProp<ViewStyle>;
  contentContainerStyle?: StyleProp<ViewStyle>;
  ListFooterComponent?: ReactElement | null;
  ListHeaderComponent?: ReactElement | null;
  ListEmptyComponent?: ReactElement | null;
  showsVerticalScrollIndicator?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  /** Fill remaining space when content is smaller than container */
  contentContainerFlexGrow?: boolean;
  /** Gesture ref for simultaneous handling with parent gestures (e.g., sidebar close) */
  simultaneousGestureRef?: MutableRefObject<GestureType | undefined>;
  /** Gesture ref(s) that the list should wait for before handling scroll */
  waitFor?: MutableRefObject<GestureType | undefined> | MutableRefObject<GestureType | undefined>[];
}

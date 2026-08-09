import type { ReactNode, RefObject } from "react";
import type {
  FlatList,
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
} from "react-native";

export interface OverlayFlatListScrollbar {
  enabled: boolean;
  onContentSizeChange: (width: number, height: number) => void;
  onLayout: (event: LayoutChangeEvent) => void;
  onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  overlay: ReactNode;
}

const ignoreContentSize = () => {};
const ignoreLayout = (_event: LayoutChangeEvent) => {};
const ignoreScroll = (_event: NativeSyntheticEvent<NativeScrollEvent>) => {};

export function useOverlayFlatListScrollbar<ItemT>(
  _listRef: RefObject<FlatList<ItemT> | null>,
  _options: { enabled: boolean },
): OverlayFlatListScrollbar {
  return {
    enabled: false,
    onContentSizeChange: ignoreContentSize,
    onLayout: ignoreLayout,
    onScroll: ignoreScroll,
    overlay: null,
  };
}

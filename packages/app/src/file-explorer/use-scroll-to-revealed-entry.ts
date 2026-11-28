import { useCallback, useEffect, useState, type RefObject } from "react";
import type { FlatList, LayoutChangeEvent } from "react-native";
import { useExplorerRevealStore } from "./reveal-request";

const CENTERED = 0.5;

/**
 * Scrolls a tree to the entry a reveal asked for, once the tree is on screen and holds the row.
 * Returns the layout and scroll-failure handlers the tree's list must use.
 */
export function useScrollToRevealedEntry<Row>({
  stateKey,
  listRef,
  rowPaths,
  onLayout,
}: {
  stateKey: string | null;
  listRef: RefObject<FlatList<Row> | null>;
  rowPaths: readonly (string | null)[];
  onLayout: (event: LayoutChangeEvent) => void;
}) {
  const requestedPath = useExplorerRevealStore((state) =>
    stateKey ? (state.pathByStateKey[stateKey] ?? null) : null,
  );
  const index = requestedPath === null ? -1 : rowPaths.indexOf(requestedPath);
  // A tree behind another tab has no height, and scrolling it does nothing.
  const [height, setHeight] = useState(0);

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      setHeight(event.nativeEvent.layout.height);
      onLayout(event);
    },
    [onLayout],
  );

  const scrollTo = useCallback(
    (rowIndex: number) =>
      listRef.current?.scrollToIndex({ index: rowIndex, viewPosition: CENTERED, animated: false }),
    [listRef],
  );

  useEffect(() => {
    if (!stateKey || index < 0 || height === 0) return;
    const frame = requestAnimationFrame(() => {
      scrollTo(index);
      useExplorerRevealStore.getState().consume(stateKey);
    });
    return () => cancelAnimationFrame(frame);
  }, [height, index, scrollTo, stateKey]);

  // The list has not measured that far yet: jump near the row so it renders, then try again.
  const onScrollToIndexFailed = useCallback(
    (info: { index: number; averageItemLength: number }) => {
      listRef.current?.scrollToOffset({
        offset: info.index * info.averageItemLength,
        animated: false,
      });
      requestAnimationFrame(() => scrollTo(info.index));
    },
    [listRef, scrollTo],
  );

  return { onLayout: handleLayout, onScrollToIndexFailed };
}

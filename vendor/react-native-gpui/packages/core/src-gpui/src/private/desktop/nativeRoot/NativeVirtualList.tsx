/**
 * A virtual list in a native tree. The list scrolls natively and reports which
 * items are in view; only those and `overscan` more on each side exist.
 *
 * ```tsx
 * <NativeVirtualList
 *   count={10000}
 *   estimatedItemHeight={32}
 *   keyExtractor={index => rows[index].id}
 *   renderItem={index => <Label text={rows[index].title} />}
 * />
 * ```
 *
 * Items are as high as their content. A native item is measured by the
 * runtime, one that holds a `NativeSlot` by the layout of its React Native
 * content; an item not measured yet counts as `estimatedItemHeight`, and when
 * an item above the viewport changes size the scroll position moves with it, so
 * nothing on screen jumps.
 *
 * Every item keeps its React identity: it is keyed by `keyExtractor` (the index
 * by default), so state inside an item stays with the data it belongs to. The
 * runtime reuses the native instances of removed items underneath, by type,
 * which makes scrolling cheap without touching what React sees. `recycleItems`
 * switches that off in favour of the FlashList way: items are keyed by their
 * position in the window, so their React state is reused for other data. State
 * inside a recycled item (a text field, a toggle, an `useState`) shows up on the
 * wrong row unless the item derives all of it from `index`; use it only for
 * stateless rows.
 *
 * Use it inside a `NativeRoot`; `renderItem` may return native components and
 * `NativeSlot`s.
 *
 * @format
 */

import * as React from 'react';

export type ScrollAlign = 'start' | 'center' | 'end';

export type NativeVirtualListHandle = {
  scrollToIndex(options: { index: number; align?: ScrollAlign }): void;
  scrollToOffset(options: { offset: number }): void;
};

export type NativeVirtualListProps = {
  count: number;
  /** The height of an item that has not been measured yet. */
  estimatedItemHeight: number;
  renderItem: (index: number) => React.ReactNode;
  /** A stable key for the item at `index`. Defaults to the index. */
  keyExtractor?: (index: number) => string;
  /** Items kept ready beyond the visible ones, on each side. Defaults to 3. */
  overscan?: number;
  /** Key items by position in the window, reusing their React state. */
  recycleItems?: boolean;
  /** Called once when the end comes within `endReachedThreshold` pixels. */
  onEndReached?: () => void;
  endReachedThreshold?: number;
  testID?: string;
};

type Range = { first: number; last: number };

type ScrollRequest = {
  id: number;
  index?: number;
  offset?: number;
  align?: ScrollAlign;
};

const List = 'NativeVirtualList' as unknown as React.ComponentType<
  Record<string, unknown>
>;
const Item = 'NativeVirtualItem' as unknown as React.ComponentType<
  Record<string, unknown>
>;

let nextListId = 1;

export const NativeVirtualList = React.forwardRef<
  NativeVirtualListHandle,
  NativeVirtualListProps
>(function VirtualListImpl(
  {
    count,
    estimatedItemHeight,
    renderItem,
    keyExtractor,
    overscan = 3,
    recycleItems = false,
    onEndReached,
    endReachedThreshold,
    testID,
  },
  ref,
) {
  const [listId] = React.useState(() => nextListId++);
  const [range, setRange] = React.useState<Range>({
    first: 0,
    last: Math.min(count, 12) - 1,
  });
  const [request, setRequest] = React.useState<ScrollRequest | undefined>();
  const requests = React.useRef(0);
  const onRangeChange = React.useCallback((next: unknown) => {
    const { first, last } = next as Range;
    setRange(previous =>
      previous.first === first && previous.last === last
        ? previous
        : { first, last },
    );
  }, []);
  const endReached = React.useRef(onEndReached);
  endReached.current = onEndReached;
  const onEnd = React.useCallback(() => endReached.current?.(), []);

  React.useImperativeHandle(
    ref,
    () => ({
      scrollToIndex({ index, align = 'start' }) {
        setRequest({ id: ++requests.current, index, align });
      },
      scrollToOffset({ offset }) {
        setRequest({ id: ++requests.current, offset });
      },
    }),
    [],
  );

  const start = Math.max(0, range.first - overscan);
  const end = Math.min(count - 1, range.last + overscan);
  const pool = range.last - range.first + 1 + 2 * overscan;
  const items: React.ReactNode[] = [];
  for (let index = start; index <= end; index++) {
    const key = recycleItems
      ? `slot-${index % pool}`
      : (keyExtractor?.(index) ?? String(index));
    items.push(
      <Item key={key} index={index} listId={listId}>
        {renderItem(index)}
      </Item>,
    );
  }
  return (
    <List
      testID={testID}
      listId={listId}
      count={count}
      estimatedItemHeight={estimatedItemHeight}
      scrollRequest={request}
      endReachedThreshold={endReachedThreshold}
      onRangeChange={onRangeChange}
      onEndReached={onEndReached == null ? undefined : onEnd}
    >
      {items}
    </List>
  );
});

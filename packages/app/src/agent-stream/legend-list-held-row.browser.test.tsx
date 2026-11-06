import { LegendList, type LegendListRef } from "@legendapp/list/react-native";
import React, { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { View } from "react-native";
import { afterEach, beforeEach, expect, it } from "vitest";

// The native chat timeline runs on the patched LegendList (patches/@legendapp+list+3.7.1.patch).
// A disclosure hold keeps only the held row in place: `shouldRestorePosition` accepts no other row.
// The native build applies its scroll adjustments through native scroll props that
// react-native-web ignores, so these tests read the offset LegendList holds, not the DOM's.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const VIEWPORT_HEIGHT = 100;

interface Row {
  id: string;
  height: number;
}

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  host.style.cssText = `display:flex;flex-direction:column;width:300px;height:${VIEWPORT_HEIGHT}px`;
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  grownHeights.clear();
  host.remove();
});

function wait(ms: number): Promise<void> {
  return act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
}

const LIST_STYLE = { flex: 1 };
const rowStyles = new Map<number, { height: number }>();

function rowStyle(height: number) {
  let style = rowStyles.get(height);
  if (!style) {
    style = { height };
    rowStyles.set(height, style);
  }
  return style;
}

// A row that changes its own height without a data change, like a todo card toggling its details.
const grownHeights = new Map<string, number>();
const heightListeners = new Set<() => void>();

function subscribeToHeights(listener: () => void) {
  heightListeners.add(listener);
  return () => heightListeners.delete(listener);
}

function growRow(id: string, height: number) {
  grownHeights.set(id, height);
  for (const listener of heightListeners) listener();
}

function RowView({ row }: { row: Row }) {
  const height = useSyncExternalStore(
    subscribeToHeights,
    () => grownHeights.get(row.id) ?? row.height,
  );
  return <View style={rowStyle(height)} />;
}

function renderRow({ item }: { item: Row }) {
  return <RowView row={item} />;
}

function holdOnly(heldRowId: string) {
  return {
    data: true,
    size: true,
    shouldRestorePosition: (item: Row) => item.id === heldRowId,
  };
}

function keyExtractor(item: Row) {
  return item.id;
}

function mountList(heldRowId: string) {
  const listRef = React.createRef<LegendListRef>();
  const maintainVisibleContentPosition = holdOnly(heldRowId);
  const render = (data: Row[]) =>
    act(() =>
      root.render(
        <LegendList
          ref={listRef}
          data={data}
          renderItem={renderRow}
          keyExtractor={keyExtractor}
          estimatedItemSize={40}
          recycleItems={false}
          scrollEventThrottle={16}
          maintainVisibleContentPosition={maintainVisibleContentPosition}
          style={LIST_STYLE}
        />,
      ),
    );
  const scrollElement = () => {
    const scroller = [...host.querySelectorAll<HTMLElement>("div")].find(
      (element) => element.scrollHeight > element.clientHeight + 1,
    );
    if (!scroller) throw new Error("The list has no scroll element");
    return scroller;
  };
  // Small steps: a large jump suspends LegendList's anchoring until the rows re-measure.
  const scrollTo = async (offset: number) => {
    for (let step = 20; step <= offset; step += 20) {
      scrollElement().scrollTop = step;
      await wait(150);
    }
  };
  const heldRowTop = () => {
    const state = listRef.current?.getState();
    const position = state?.positionByKey(heldRowId);
    if (state === undefined || position === undefined) {
      throw new Error("The held row is not laid out");
    }
    return position - state.scroll;
  };
  return { render, scrollTo, heldRowTop };
}

it("anchors a data change on a held row whose top is above the viewport", async () => {
  // The held row is a turn host whose prompt bubble is cut off at the top of the viewport, with a
  // fully visible row below it. LegendList's ids in view start at that fully visible row.
  const rows: Row[] = Array.from({ length: 10 }, (_, index) => ({
    id: `row-${index}`,
    height: index === 3 ? 60 : 40,
  }));
  const list = mountList("row-3");
  list.render(rows);
  await wait(150);
  await list.scrollTo(140);
  expect(list.heldRowTop()).toBe(-20);

  const inserted: Row = { id: "inserted", height: 30 };
  list.render([...rows.slice(0, 2), inserted, ...rows.slice(2)]);
  await wait(150);

  expect(list.heldRowTop()).toBe(-20);
});

it("anchors a size change on a held row whose top is above the viewport", async () => {
  // The same cut-off row grows from its own state, so LegendList sees a size change only.
  const rows: Row[] = Array.from({ length: 10 }, (_, index) => ({
    id: `row-${index}`,
    height: index === 3 ? 60 : 40,
  }));
  const list = mountList("row-3");
  list.render(rows);
  await wait(150);
  await list.scrollTo(140);
  expect(list.heldRowTop()).toBe(-20);

  act(() => growRow("row-3", 260));
  await wait(150);

  expect(list.heldRowTop()).toBe(-20);
});

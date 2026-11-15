import { LegendList, type LegendListRef } from "@legendapp/list/react-native";
import React, { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { View } from "react-native";
import { afterEach, beforeEach, expect, it } from "vitest";
import { disclosureAnchor } from "./native-disclosure-hold";

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
  const rowSize = (rowId: string) => listRef.current?.getState().sizes.get(rowId);
  const rowBottom = (rowId: string) => {
    const state = listRef.current?.getState();
    const position = state?.positionByKey(rowId);
    const size = state?.sizes.get(rowId);
    if (state === undefined || position === undefined || size === undefined) {
      throw new Error(`Row ${rowId} is not laid out`);
    }
    return position + size - state.scroll;
  };
  return { render, scrollTo, heldRowTop, rowSize, rowBottom };
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

// A long message's show more sits under the text it opens, on the bottom edge of its row. The
// strategy anchors the row below it, whose top is that bottom edge.
const bottomTriggerRows: Row[] = Array.from({ length: 10 }, (_, index) => ({
  id: `row-${index}`,
  height: index === 3 ? 60 : 40,
}));

function mountBottomTriggerHold(rowId: string) {
  const anchor = disclosureAnchor(bottomTriggerRows, rowId, "bottom");
  if (anchor.kind !== "row") throw new Error(`Row ${rowId} has no row below it`);
  return mountList(anchor.rowId);
}

it("keeps the bottom of a row whose trigger sits under its growing content", async () => {
  const list = mountBottomTriggerHold("row-3");
  list.render(bottomTriggerRows);
  await wait(150);
  await list.scrollTo(100);
  const triggerBottom = list.rowBottom("row-3");
  expect(triggerBottom).toBe(80);

  act(() => growRow("row-3", 260));
  await wait(150);
  expect(list.rowBottom("row-3")).toBe(triggerBottom);

  act(() => growRow("row-3", 60));
  await wait(150);
  expect(list.rowBottom("row-3")).toBe(triggerBottom);
});

it("keeps the bottom of a bottom-trigger row whose top is above the viewport", async () => {
  const list = mountBottomTriggerHold("row-3");
  list.render(bottomTriggerRows);
  await wait(150);
  await list.scrollTo(140);
  const triggerBottom = list.rowBottom("row-3");
  expect(triggerBottom).toBe(40);

  act(() => growRow("row-3", 260));
  await wait(150);
  expect(list.rowBottom("row-3")).toBe(triggerBottom);

  act(() => growRow("row-3", 60));
  await wait(150);
  expect(list.rowBottom("row-3")).toBe(triggerBottom);
});

it("keeps the bottom of a bottom-trigger row that ends below the viewport", async () => {
  // In the app the row ends with the message's timestamp under the trigger, so a trigger near the
  // bottom of the viewport has its row's bottom, and the row below, out of view.
  const list = mountBottomTriggerHold("row-3");
  list.render(bottomTriggerRows);
  await wait(150);
  await list.scrollTo(40);
  const rowBottom = list.rowBottom("row-3");
  expect(rowBottom).toBe(140);

  act(() => growRow("row-3", 260));
  await wait(150);
  expect(list.rowBottom("row-3")).toBe(rowBottom);

  act(() => growRow("row-3", 60));
  await wait(150);
  expect(list.rowBottom("row-3")).toBe(rowBottom);
});

it("keeps measured row sizes while the list is not laid out", async () => {
  // A hidden retained tab is display: none. Its rows still render, and a row measured there
  // reports 0 x 0. When the tab shows again, a row whose frame did not change gets no new layout
  // event, so a 0 recorded while hidden would stay and the next row would overlap it.
  const rows: Row[] = Array.from({ length: 3 }, (_, index) => ({ id: `row-${index}`, height: 40 }));
  const list = mountList("row-0");
  list.render(rows);
  await wait(150);
  expect(rows.map((row) => list.rowSize(row.id))).toEqual([40, 40, 40]);

  host.style.display = "none";
  await wait(150);
  list.render(rows.map((row) => ({ ...row })));
  await wait(150);

  expect(rows.map((row) => list.rowSize(row.id))).toEqual([40, 40, 40]);
});

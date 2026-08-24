/**
 * @vitest-environment jsdom
 */
import React, { memo } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DraggableListDragHandleProps } from "./draggable-list.types";
import { DraggableList, type DraggableRenderItemInfo } from "./draggable-list.web";

interface Item {
  id: string;
}

const items: Item[] = [{ id: "one" }];

function keyExtractor(item: Item): string {
  return item.id;
}

function onDragEnd() {}

let root: Root | null = null;
let container: HTMLElement | null = null;
let rowRenderCount = 0;

const Row = memo(function Row({
  dragHandleProps: _dragHandleProps,
}: {
  dragHandleProps?: DraggableListDragHandleProps;
}) {
  rowRenderCount += 1;
  return <div>row</div>;
});

function renderRow(info: DraggableRenderItemInfo<Item>) {
  return <Row dragHandleProps={info.dragHandleProps} />;
}

function renderReplacementRow(info: DraggableRenderItemInfo<Item>) {
  return <Row dragHandleProps={info.dragHandleProps} />;
}

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  rowRenderCount = 0;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

describe("DraggableList web row stability", () => {
  it("keeps drag handle props stable when the render callback changes", () => {
    act(() => {
      root?.render(
        <DraggableList
          data={items}
          keyExtractor={keyExtractor}
          renderItem={renderRow}
          onDragEnd={onDragEnd}
          useDragHandle
        />,
      );
    });
    expect(rowRenderCount).toBe(1);

    act(() => {
      root?.render(
        <DraggableList
          data={items}
          keyExtractor={keyExtractor}
          renderItem={renderReplacementRow}
          onDragEnd={onDragEnd}
          useDragHandle
        />,
      );
    });

    expect(rowRenderCount).toBe(1);
  });
});

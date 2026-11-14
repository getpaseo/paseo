import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DraggableList,
  DraggableListHandle,
  type DraggableRenderItemInfo,
} from "./draggable-list.web";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

interface Item {
  id: string;
}

function keyExtractor(item: Item): string {
  return item.id;
}

function noop() {}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function renderRowWithHandle(info: DraggableRenderItemInfo<Item>) {
  return (
    <div>
      <DraggableListHandle accessibilityLabel={`Move ${info.item.id}`} testID="row-handle">
        <span>grip</span>
      </DraggableListHandle>
      <span data-testid="row-body">{info.item.id}</span>
    </div>
  );
}

function renderList(onDragBegin: () => void) {
  act(() => {
    root?.render(
      <DraggableList
        data={[{ id: "one" }, { id: "two" }]}
        keyExtractor={keyExtractor}
        renderItem={renderRowWithHandle}
        onDragEnd={noop}
        onDragBegin={onDragBegin}
        useDragHandle
      />,
    );
  });
}

function byTestId(testID: string): HTMLElement {
  const found = container?.querySelector(`[data-testid="${testID}"]`);
  if (!(found instanceof HTMLElement)) throw new Error(`Nothing rendered as ${testID}`);
  return found;
}

/** Press on the element's centre, move the mouse down by `distance`, and release. */
function pressAndMove(element: HTMLElement, distance: number) {
  const { left, top, width, height } = element.getBoundingClientRect();
  const x = left + width / 2;
  const y = top + height / 2;
  act(() => {
    element.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: x, clientY: y }),
    );
  });
  act(() => {
    document.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y + distance }),
    );
  });
  act(() => {
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
}

describe("DraggableListHandle on web", () => {
  it("starts the row's drag from the handle, and only from the handle", () => {
    const onDragBegin = vi.fn();
    renderList(onDragBegin);

    pressAndMove(byTestId("row-body"), 20);
    expect(onDragBegin).not.toHaveBeenCalled();

    pressAndMove(byTestId("row-handle"), 20);
    expect(onDragBegin).toHaveBeenCalledTimes(1);
  });

  it("is a labelled button rather than dnd-kit's sortable", () => {
    renderList(noop);
    const handle = byTestId("row-handle");

    expect(handle.getAttribute("role")).toBe("button");
    expect(handle.getAttribute("aria-label")).toBe("Move one");
    expect(handle.getAttribute("aria-roledescription")).toBeNull();
  });
});

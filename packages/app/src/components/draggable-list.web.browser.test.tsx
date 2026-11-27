import React, { act, useCallback, useState } from "react";
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
  label?: string;
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
      <span data-testid="row-body">{info.item.label ?? info.item.id}</span>
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

const OWNER_DELAY_MS = 50;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * An owner that relabels its rows as soon as one is dropped, and whose new order reaches the list
 * in a later render, like one that saves to a store.
 */
function ListWithLateOwner() {
  const [items, setItems] = useState<Item[]>([{ id: "one" }, { id: "two" }]);
  const relabelThenReorderLater = useCallback((next: Item[]) => {
    const relabel = (item: Item): Item => ({ id: item.id, label: `${item.id} dropped` });
    setItems((current) => current.map(relabel));
    setTimeout(() => setItems(next.map(relabel)), OWNER_DELAY_MS);
  }, []);
  return (
    <DraggableList
      data={items}
      keyExtractor={keyExtractor}
      renderItem={renderRowWithHandle}
      onDragEnd={relabelThenReorderLater}
      useDragHandle
    />
  );
}

function rowOrder(): (string | null)[] {
  return Array.from(container?.querySelectorAll('[data-testid="row-body"]') ?? []).map(
    (row) => row.textContent,
  );
}

/** Drag the element down by `distance` in two mouse moves, letting dnd-kit measure in between. */
async function dragDown(element: HTMLElement, distance: number) {
  const { left, top, width, height } = element.getBoundingClientRect();
  const x = left + width / 2;
  const y = top + height / 2;
  await act(async () => {
    element.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: x, clientY: y }),
    );
  });
  for (const moved of [distance / 2, distance]) {
    await act(async () => {
      document.dispatchEvent(
        new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y + moved }),
      );
      await wait(20);
    });
  }
  act(() => {
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
}

describe("DraggableList on web", () => {
  it("shows the owner's current rows in the dropped order until its new order arrives", async () => {
    act(() => {
      root?.render(<ListWithLateOwner />);
    });
    const [firstHandle] = Array.from(
      container?.querySelectorAll<HTMLElement>('[data-testid="row-handle"]') ?? [],
    );
    const [firstRow, secondRow] = Array.from(
      container?.querySelectorAll<HTMLElement>('[data-testid="row-body"]') ?? [],
    );
    const rowDistance =
      secondRow.getBoundingClientRect().top - firstRow.getBoundingClientRect().top;

    await dragDown(firstHandle, rowDistance);
    expect(rowOrder()).toEqual(["two dropped", "one dropped"]);

    await act(() => wait(OWNER_DELAY_MS * 2));
    expect(rowOrder()).toEqual(["two dropped", "one dropped"]);
  });
});

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

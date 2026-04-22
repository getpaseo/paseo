/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SortableInlineList } from "./sortable-inline-list.web";

type DndContextProps = {
  onDragStart?: (event: { active: { id: string } }) => void;
  onDragCancel?: () => void;
};

let latestDndContextProps: DndContextProps | null = null;

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children, ...props }: React.PropsWithChildren<DndContextProps>) => {
    latestDndContextProps = props;
    return <div>{children}</div>;
  },
  closestCenter: vi.fn(),
  KeyboardSensor: vi.fn(),
  PointerSensor: vi.fn(),
  useSensor: vi.fn(() => ({})),
  useSensors: vi.fn(() => []),
}));

vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: React.PropsWithChildren) => <>{children}</>,
  arrayMove: <T,>(items: T[], from: number, to: number) => {
    const next = [...items];
    const [item] = next.splice(from, 1);
    if (item !== undefined) {
      next.splice(to, 0, item);
    }
    return next;
  },
  horizontalListSortingStrategy: {},
  sortableKeyboardCoordinates: vi.fn(),
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    setActivatorNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
}));

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  latestDndContextProps = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
  }
  root = null;
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
});

function renderList(): void {
  act(() => {
    root?.render(
      <SortableInlineList
        data={["alpha", "beta"]}
        keyExtractor={(item) => item}
        onDragEnd={vi.fn()}
        renderItem={({ item, isActive }) => (
          <div data-active={String(isActive)} data-testid={`item-${item}`}>
            {item}
          </div>
        )}
      />,
    );
  });
}

function getItemActiveState(item: string): string | null {
  return (
    container?.querySelector(`[data-testid="item-${item}"]`)?.getAttribute("data-active") ?? null
  );
}

describe("SortableInlineList web", () => {
  it("clears active drag state when a drag is cancelled", () => {
    renderList();

    act(() => {
      latestDndContextProps?.onDragStart?.({ active: { id: "alpha" } });
    });
    expect(getItemActiveState("alpha")).toBe("true");

    act(() => {
      latestDndContextProps?.onDragCancel?.();
    });
    expect(getItemActiveState("alpha")).toBe("false");
  });
});

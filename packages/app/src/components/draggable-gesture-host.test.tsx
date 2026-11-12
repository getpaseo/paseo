/** @vitest-environment jsdom */
import React, { memo } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native-draggable-flatlist", () => {
  const List = ({ dragGestureHostPresented }: { dragGestureHostPresented?: boolean }) => (
    <span data-testid="host">{String(dragGestureHostPresented)}</span>
  );
  return { default: List, NestableDraggableFlatList: List };
});

import { DraggableGestureHostPresentedContext } from "./draggable-gesture-host";
import { DraggableList } from "./draggable-list.native";

const items: string[] = [];
const keyExtractor = (item: string) => item;
const renderItem = () => <div />;
const onDragEnd = () => {};
const NestedList = memo(function NestedList() {
  return (
    <DraggableList
      data={items}
      keyExtractor={keyExtractor}
      renderItem={renderItem}
      onDragEnd={onDragEnd}
      nestable
    />
  );
});

describe("draggable gesture host presentation", () => {
  it("updates a memoized nested list when its retained host hides and reappears", () => {
    const { rerender } = render(
      <DraggableGestureHostPresentedContext value>
        <NestedList />
      </DraggableGestureHostPresentedContext>,
    );
    expect(screen.getByTestId("host").textContent).toBe("true");
    rerender(
      <DraggableGestureHostPresentedContext value={false}>
        <NestedList />
      </DraggableGestureHostPresentedContext>,
    );
    expect(screen.getByTestId("host").textContent).toBe("false");
    rerender(
      <DraggableGestureHostPresentedContext value>
        <NestedList />
      </DraggableGestureHostPresentedContext>,
    );
    expect(screen.getByTestId("host").textContent).toBe("true");
  });
});

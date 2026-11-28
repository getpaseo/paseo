import React, { act, Children, useCallback, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { useContentDrag, withContentDrag } from "./content-drag";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

interface FakeScrollProps {
  scrollEnabled?: boolean;
  children?: ReactNode;
}

/** Stands in for a scroll view: it reports the props a native scroll view would act on. */
function FakeScroll({ scrollEnabled, children }: FakeScrollProps) {
  return (
    <div
      data-testid="scroll"
      data-scroll-enabled={String(scrollEnabled)}
      data-child-count={Children.toArray(children).length}
    >
      {children}
    </div>
  );
}

const DragHostScroll = withContentDrag<FakeScrollProps, unknown>(FakeScroll);

/** A row that holds a drag the way a draggable list does: active from press until release. */
function DragRow() {
  const { setActive } = useContentDrag();
  const arm = useCallback(() => setActive(true), [setActive]);
  const release = useCallback(() => setActive(false), [setActive]);
  return (
    <>
      <button type="button" data-testid="arm" onClick={arm} />
      <button type="button" data-testid="release" onClick={release} />
    </>
  );
}

function mount(node: React.ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function scroll(): HTMLElement {
  const found = document.querySelector('[data-testid="scroll"]');
  if (!(found instanceof HTMLElement)) throw new Error("No scroll view rendered");
  return found;
}

function press(testID: string) {
  const button = document.querySelector(`[data-testid="${testID}"]`);
  if (!(button instanceof HTMLElement)) throw new Error(`No ${testID}`);
  act(() => button.click());
}

describe("withContentDrag", () => {
  it("stops the scroll while a child drag holds the touch, and resumes after", () => {
    mount(
      <DragHostScroll>
        <DragRow />
      </DragHostScroll>,
    );

    expect(scroll().dataset.scrollEnabled).toBe("true");
    press("arm");
    expect(scroll().dataset.scrollEnabled).toBe("false");
    press("release");
    expect(scroll().dataset.scrollEnabled).toBe("true");
  });

  it("keeps a scroll view the caller disabled disabled after the drag", () => {
    mount(
      <DragHostScroll scrollEnabled={false}>
        <DragRow />
      </DragHostScroll>,
    );

    press("arm");
    press("release");
    expect(scroll().dataset.scrollEnabled).toBe("false");
  });

  it("passes the children through as given, so sticky header indices still count them", () => {
    mount(
      <DragHostScroll>
        <div>Intro</div>
        <div>Section header</div>
        <DragRow />
      </DragHostScroll>,
    );

    expect(scroll().dataset.childCount).toBe("3");
  });
});

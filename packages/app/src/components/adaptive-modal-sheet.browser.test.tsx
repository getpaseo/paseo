import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RotateCw, Settings } from "lucide-react-native";
import { afterEach, describe, expect, it } from "vitest";
import {
  InlineHeaderView,
  SheetHeaderIconButton,
  SheetHeaderView,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function noop() {}

const LONG_TITLE =
  "A sheet title long enough to fill the whole header row on a phone and then some more";

const header: SheetHeader = {
  title: LONG_TITLE,
  actions: (
    <>
      <SheetHeaderIconButton icon={RotateCw} label="Refresh" onPress={noop} testID="refresh" />
      <SheetHeaderIconButton icon={Settings} label="Settings" onPress={noop} testID="settings" />
    </>
  ),
};

function mount(node: React.ReactNode) {
  container = document.createElement("div");
  container.style.width = "390px";
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function rectOf(testID: string): DOMRect {
  const found = document.querySelector(`[data-testid="${testID}"]`);
  if (!(found instanceof HTMLElement)) throw new Error(`Nothing rendered as ${testID}`);
  return found.getBoundingClientRect();
}

/** Each button keeps its own width, follows the previous one and stays inside the row. */
function expectButtonsInRow(testIDs: string[]) {
  const row = container?.getBoundingClientRect();
  if (!row) throw new Error("Nothing mounted");
  const rects = testIDs.map(rectOf);
  for (const [index, rect] of rects.entries()) {
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.right).toBeLessThanOrEqual(row.right + 1);
    const previous = rects[index - 1];
    if (previous) expect(rect.left).toBeGreaterThanOrEqual(previous.right);
  }
}

describe("sheet header with a long title", () => {
  it("truncates the title and keeps the actions and Close in place", () => {
    mount(<SheetHeaderView header={header} onClose={noop} closeTestID="close" />);

    expectButtonsInRow(["refresh", "settings", "close"]);
  });

  it("does the same in the inline header", () => {
    mount(<InlineHeaderView header={header} />);

    expectButtonsInRow(["refresh", "settings"]);
  });
});

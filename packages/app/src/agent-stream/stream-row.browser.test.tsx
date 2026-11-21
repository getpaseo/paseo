import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import type { StreamLayoutItem } from "./layout";
import type { StreamViewportHandle } from "./strategy";
import { renderStreamRow } from "./stream-row";

// stream-row.tsx is compiled with the React Compiler here, as Expo compiles it.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const turnHost: StreamItem = {
  kind: "user_message",
  id: "host",
  text: "Fix the build",
  timestamp: new Date(0),
};

const turnHostLayout: StreamLayoutItem = {
  item: turnHost,
  aboveItem: null,
  // The turn's rows land below another row, so opening it leaves the host's layout unchanged.
  belowItem: null,
  gapBelow: 0,
  assistantSpacing: "default",
  completedFooter: null,
  toolSequence: "none",
  isFirstInUserGroup: true,
  isLastInUserGroup: true,
  isLastInToolSequence: false,
  frameOrder: "content-then-footer",
  phase: "complete",
};

it("renders a revised row again when its layout is unchanged", () => {
  // The turn's open state lives outside the row, as `getCollapsedTurn` reads it in view.tsx.
  let turnOpen = false;
  const renderStreamItem = () => <span>{turnOpen ? "open" : "closed"}</span>;
  const viewportRef = createRef<StreamViewportHandle>();
  const layoutItemById = new Map([[turnHost.id, turnHostLayout]]);
  const renderRow = (item: StreamItem) =>
    act(() =>
      root.render(renderStreamRow({ item, layoutItemById, renderStreamItem, viewportRef })),
    );

  renderRow(turnHost);
  expect(host.textContent).toBe("closed");

  turnOpen = true;
  // useRevisedHistoryRows hands the row a fresh item when its display state changes.
  renderRow({ ...turnHost });

  expect(host.textContent).toBe("open");
});

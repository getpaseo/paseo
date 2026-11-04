// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { createRef } from "react";
import { expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import type { StreamLayoutItem } from "./layout";
import type { StreamViewportHandle } from "./strategy";
import { renderStreamRow } from "./stream-row";

// stream-row.tsx is compiled with the React Compiler here, as Expo compiles it.

const host: StreamItem = {
  kind: "user_message",
  id: "host",
  text: "Fix the build",
  timestamp: new Date(0),
};

const hostLayout: StreamLayoutItem = {
  item: host,
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
  const layoutItemById = new Map([[host.id, hostLayout]]);
  const row = (item: StreamItem) =>
    renderStreamRow({ item, layoutItemById, renderStreamItem, viewportRef });

  const view = render(<>{row(host)}</>);
  expect(view.container.textContent).toBe("closed");

  turnOpen = true;
  // useRevisedHistoryRows hands the row a fresh item when its display state changes.
  view.rerender(<>{row({ ...host })}</>);

  expect(view.container.textContent).toBe("open");
});

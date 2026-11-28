import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { WorkspaceRowBadgeItem } from "@getpaseo/plugin/client";
import type { WorkspaceRowBadgesProps } from "@getpaseo/plugin/client/ui";
import { afterEach, expect, it } from "vitest";
import { entityRefs } from "../client-state/refs";
import {
  useWorkspaceRowBadgeItems,
  WorkspaceRowBadges,
  WorkspaceRowBadgesContext,
  type WorkspaceRowBadgesSource,
} from "./kit";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function render(element: React.ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
}

const state: WorkspaceRowBadgeItem = {
  key: "status/state",
  pluginId: "status",
  itemId: "state",
  title: "Status",
  icon: "Gauge",
  hostIds: ["host-1"],
};

function HostBadges({ workspace, items }: WorkspaceRowBadgesProps) {
  return <span>{`${workspace.hostId}/${workspace.id}: ${items?.join(",") ?? "all"}`}</span>;
}

const source: WorkspaceRowBadgesSource = { items: [state], Badges: HostBadges };

function ItemTitles() {
  const items = useWorkspaceRowBadgeItems();
  return <span>{items.length === 0 ? "none" : items.map((item) => item.title).join(",")}</span>;
}

it("lists and draws nothing outside a sidebar view", () => {
  render(
    <>
      <ItemTitles />
      <WorkspaceRowBadges workspace={entityRefs.workspace("host-1", "ws-1")} />
    </>,
  );
  expect(container?.textContent).toBe("none");
});

it("lists the slot's items", () => {
  render(
    <WorkspaceRowBadgesContext.Provider value={source}>
      <ItemTitles />
    </WorkspaceRowBadgesContext.Provider>,
  );
  expect(container?.textContent).toBe("Status");
});

it("draws the slot's badges for the workspace and the chosen items", () => {
  render(
    <WorkspaceRowBadgesContext.Provider value={source}>
      <WorkspaceRowBadges workspace={entityRefs.workspace("host-1", "ws-1")} />
      {" | "}
      <WorkspaceRowBadges
        workspace={entityRefs.workspace("host-1", "ws-2")}
        items={["status/state"]}
      />
    </WorkspaceRowBadgesContext.Provider>,
  );
  expect(container?.textContent).toBe("host-1/ws-1: all | host-1/ws-2: status/state");
});

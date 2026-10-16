import { expect, test } from "vitest";
import {
  createWorkspaceLayoutStore,
  collectAllTabs,
  collectAllPanes,
} from "@/stores/workspace-layout-store";
import { applyTabOrder } from "./layout";

function agentIds(layout: Parameters<typeof applyTabOrder>[0]) {
  return collectAllTabs(layout.root).flatMap((tab) =>
    tab.target.kind === "agent" ? [tab.target.agentId] : [],
  );
}
test("stable target identities reorder device-local tab ids without opening missing tabs or moving focus", () => {
  const store = createWorkspaceLayoutStore();
  const key = "host:w";
  store
    .getState()
    .openTab({ workspaceKey: key, target: { kind: "agent", agentId: "a" }, intent: "new" });
  store
    .getState()
    .openTab({ workspaceKey: key, target: { kind: "agent", agentId: "b" }, intent: "new" });
  const initial = store.getState().layoutByWorkspace[key]!;
  const focus = collectAllPanes(initial.root).map((pane) => [pane.id, pane.focusedTabId]);
  const next = applyTabOrder(initial, ["agent_missing", "agent_b", "agent_a"]);
  expect(agentIds(next)).toEqual(["b", "a"]);
  expect(collectAllPanes(next.root).map((pane) => [pane.id, pane.focusedTabId])).toEqual(focus);
  expect(collectAllTabs(next.root)).toHaveLength(collectAllTabs(initial.root).length);
  expect(applyTabOrder(next, ["agent_b", "agent_a"])).toBe(next);
});
test("reordering keeps split panes, sizes and pane membership device-local", () => {
  const store = createWorkspaceLayoutStore();
  const key = "host:w";
  const a = store
    .getState()
    .openTab({ workspaceKey: key, target: { kind: "agent", agentId: "a" }, intent: "new" })!;
  store
    .getState()
    .openTab({ workspaceKey: key, target: { kind: "agent", agentId: "b" }, intent: "new" });
  const sourcePane = collectAllPanes(store.getState().layoutByWorkspace[key]!.root)[0]!;
  store.getState().splitPane(key, { tabId: a, targetPaneId: sourcePane.id, position: "right" });
  const initial = store.getState().layoutByWorkspace[key]!;
  const next = applyTabOrder(initial, ["agent_b", "agent_a"]);
  expect(collectAllPanes(next.root).map((pane) => pane.tabIds)).toEqual(
    collectAllPanes(initial.root).map((pane) => pane.tabIds),
  );
  expect(next).toBe(initial);
});

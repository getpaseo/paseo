import { expect, it } from "vitest";
import { acceptWorkspaceRowPress, type WorkspaceRowPress } from "./accept";

function rowPress(overrides: Partial<WorkspaceRowPress> = {}) {
  const visible: string[] = [];
  const press: WorkspaceRowPress = {
    cancelled: false,
    native: true,
    selected: false,
    sidebar: "overlay",
    target: "agent-list",
    acknowledge: () => visible.push("row"),
    navigate: () => visible.push("workspace"),
    ...overrides,
  };
  return { press, visible };
}

it("acknowledges an accepted row before navigation starts", () => {
  const { press, visible } = rowPress();
  expect(acceptWorkspaceRowPress(press)).toBe(true);
  expect(visible).toEqual(["row", "workspace"]);
});

it("does not acknowledge or navigate after scrolling or a long press claims the touch", () => {
  const { press, visible } = rowPress({ cancelled: true });
  expect(acceptWorkspaceRowPress(press)).toBe(false);
  expect(visible).toEqual([]);
});

it("accepts only the first row while its selection closes the sidebar", () => {
  const { press, visible } = rowPress();
  press.navigate = () => {
    press.target = "agent";
    visible.push("workspace B");
  };
  expect(acceptWorkspaceRowPress(press)).toBe(true);
  expect(acceptWorkspaceRowPress(press)).toBe(false);
  expect(visible).toEqual(["row", "workspace B"]);
});

it.each([
  {
    name: "open phone or tablet overlay",
    sidebar: "overlay",
    target: "agent-list",
    native: true,
    accepted: true,
  },
  { name: "closing overlay", sidebar: "overlay", target: "agent", native: true, accepted: false },
  {
    name: "explorer covering an overlay",
    sidebar: "overlay",
    target: "file-explorer",
    native: true,
    accepted: false,
  },
  { name: "docked sidebar", sidebar: "dock", target: "agent", native: true, accepted: true },
  {
    name: "docked sidebar beside explorer",
    sidebar: "dock",
    target: "file-explorer",
    native: true,
    accepted: true,
  },
  { name: "hidden sidebar", sidebar: "hidden", target: "agent", native: true, accepted: false },
  {
    name: "suspended open overlay",
    sidebar: "suspended",
    target: "agent-list",
    native: true,
    accepted: true,
  },
  {
    name: "suspended closed overlay",
    sidebar: "suspended",
    target: "agent",
    native: true,
    accepted: false,
  },
  {
    name: "web sidebar independent of native panel target",
    sidebar: "overlay",
    target: "agent",
    native: false,
    accepted: true,
  },
] as const)("uses the panel state for $name", ({ accepted, name: _, ...state }) => {
  const { press, visible } = rowPress(state);
  expect(acceptWorkspaceRowPress(press)).toBe(accepted);
  expect(visible).toEqual(accepted ? ["row", "workspace"] : []);
});

it("does not leave an acknowledgement over an already selected docked row", () => {
  const { press, visible } = rowPress({ selected: true, sidebar: "dock", target: "agent" });
  expect(acceptWorkspaceRowPress(press)).toBe(true);
  expect(visible).toEqual(["workspace"]);
});

it("still acknowledges a selected overlay row before the sidebar leaves", () => {
  const { press, visible } = rowPress({ selected: true });
  expect(acceptWorkspaceRowPress(press)).toBe(true);
  expect(visible).toEqual(["row", "workspace"]);
});

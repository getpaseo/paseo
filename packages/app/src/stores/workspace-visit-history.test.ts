import { describe, expect, it } from "vitest";
import type { ActiveWorkspaceSelection } from "./last-workspace-selection";
import { createWorkspaceVisitHistory } from "./workspace-visit-history";

const A: ActiveWorkspaceSelection = { serverId: "host", workspaceId: "a" };
const B: ActiveWorkspaceSelection = { serverId: "host", workspaceId: "b" };
const C: ActiveWorkspaceSelection = { serverId: "host", workspaceId: "c" };
const D: ActiveWorkspaceSelection = { serverId: "other-host", workspaceId: "a" };

const always = () => true;

function visit(
  history: ReturnType<typeof createWorkspaceVisitHistory>,
  ...selections: ActiveWorkspaceSelection[]
) {
  for (const selection of selections) {
    history.record(selection);
  }
}

// Simulates a history step followed by the route change it triggers.
function stepAndLand(history: ReturnType<typeof createWorkspaceVisitHistory>, delta: 1 | -1) {
  const target = history.step(delta, always);
  if (target) {
    history.record(target);
  }
  return target;
}

describe("createWorkspaceVisitHistory", () => {
  it("walks back and forward through visits", () => {
    const history = createWorkspaceVisitHistory();
    visit(history, A, B, C);

    expect(stepAndLand(history, -1)).toEqual(B);
    expect(stepAndLand(history, -1)).toEqual(A);
    expect(stepAndLand(history, -1)).toBeNull();
    expect(stepAndLand(history, 1)).toEqual(B);
    expect(stepAndLand(history, 1)).toEqual(C);
    expect(stepAndLand(history, 1)).toBeNull();
  });

  it("returns null with no history", () => {
    const history = createWorkspaceVisitHistory();
    expect(history.step(-1, always)).toBeNull();
    expect(history.step(1, always)).toBeNull();
    expect(history.previous(always)).toBeNull();
  });

  it("drops forward entries when visiting a new workspace after going back", () => {
    const history = createWorkspaceVisitHistory();
    visit(history, A, B, C);
    stepAndLand(history, -1);
    stepAndLand(history, -1);

    visit(history, D);

    expect(history.canStep(1, always)).toBe(false);
    expect(stepAndLand(history, -1)).toEqual(A);
  });

  it("ignores repeated records of the current workspace", () => {
    const history = createWorkspaceVisitHistory();
    visit(history, A, A, B, B, B);

    expect(stepAndLand(history, -1)).toEqual(A);
    expect(stepAndLand(history, -1)).toBeNull();
  });

  it("does not push an entry when a history step lands", () => {
    const history = createWorkspaceVisitHistory();
    visit(history, A, B);
    stepAndLand(history, -1);

    expect(stepAndLand(history, 1)).toEqual(B);
    expect(history.canStep(1, always)).toBe(false);
  });

  it("treats a different landing after a step as a new visit", () => {
    const history = createWorkspaceVisitHistory();
    visit(history, A, B, C);
    history.step(-1, always);

    visit(history, D);

    expect(history.canStep(1, always)).toBe(false);
    expect(stepAndLand(history, -1)).toEqual(B);
  });

  it("skips unavailable workspaces", () => {
    const history = createWorkspaceVisitHistory();
    visit(history, A, B, C);
    const isAvailable = (selection: ActiveWorkspaceSelection) => selection.workspaceId !== "b";

    expect(history.step(-1, isAvailable)).toEqual(A);
  });

  it("does not step onto the workspace already open", () => {
    const history = createWorkspaceVisitHistory();
    visit(history, A, B, A);

    expect(stepAndLand(history, -1)).toEqual(B);
  });

  it("caps the stack at the limit", () => {
    const history = createWorkspaceVisitHistory({ limit: 2 });
    visit(history, A, B, C);

    expect(stepAndLand(history, -1)).toEqual(B);
    expect(stepAndLand(history, -1)).toBeNull();
  });

  it("toggles between the two most recent workspaces", () => {
    const history = createWorkspaceVisitHistory();
    visit(history, A, B);

    const first = history.previous(always);
    expect(first).toEqual(A);
    visit(history, A);

    const second = history.previous(always);
    expect(second).toEqual(B);
    visit(history, B);

    expect(history.previous(always)).toEqual(A);
  });

  it("toggles past unavailable workspaces", () => {
    const history = createWorkspaceVisitHistory();
    visit(history, A, B, C);
    const isAvailable = (selection: ActiveWorkspaceSelection) => selection.workspaceId !== "b";

    expect(history.previous(isAvailable)).toEqual(A);
  });
});

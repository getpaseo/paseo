import { describe, expect, it } from "vitest";
import {
  enterWorkspaceSelection,
  exitWorkspaceSelection,
  INITIAL_WORKSPACE_SELECTION_STATE,
  isShiftPressEvent,
  reconcileWorkspaceSelection,
  selectWorkspaceRange,
  toggleWorkspaceSelection,
} from "./selection-state";

describe("sidebar workspace selection state", () => {
  it("enters selection with the clicked workspace as anchor", () => {
    const state = enterWorkspaceSelection("ws-2");
    expect({
      active: state.active,
      selected: [...state.selectedKeys],
      anchorKey: state.anchorKey,
    }).toEqual({
      active: true,
      selected: ["ws-2"],
      anchorKey: "ws-2",
    });
  });

  it("toggles workspaces on plain click without needing Shift", () => {
    let state = enterWorkspaceSelection("ws-1");
    state = toggleWorkspaceSelection(state, "ws-3");
    expect([...state.selectedKeys]).toEqual(["ws-1", "ws-3"]);
    expect(state.anchorKey).toBe("ws-3");

    state = toggleWorkspaceSelection(state, "ws-1");
    expect([...state.selectedKeys]).toEqual(["ws-3"]);
    expect(state.anchorKey).toBe("ws-1");

    state = toggleWorkspaceSelection(state, "ws-3");
    expect(state.active).toBe(true);
    expect([...state.selectedKeys]).toEqual([]);
  });

  it("selects an inclusive range on Shift+click in either direction while keeping prior picks", () => {
    const visible = ["ws-1", "ws-2", "ws-3", "ws-4", "ws-5"];
    let state = enterWorkspaceSelection("ws-1");
    state = toggleWorkspaceSelection(state, "ws-3");

    state = selectWorkspaceRange(state, "ws-5", visible);
    expect([...state.selectedKeys]).toEqual(["ws-1", "ws-3", "ws-4", "ws-5"]);
    expect(state.anchorKey).toBe("ws-3");

    const backward = selectWorkspaceRange(enterWorkspaceSelection("ws-4"), "ws-2", visible);
    expect([...backward.selectedKeys].sort()).toEqual(["ws-2", "ws-3", "ws-4"]);
  });

  it("falls back to adding the target when the anchor is no longer in the visible list", () => {
    const state = selectWorkspaceRange(enterWorkspaceSelection("ws-hidden"), "ws-2", [
      "ws-1",
      "ws-2",
    ]);
    expect([...state.selectedKeys]).toEqual(["ws-hidden", "ws-2"]);
    expect(state.anchorKey).toBe("ws-2");
  });

  it("reconciles removed workspaces and clears a missing anchor", () => {
    let state = enterWorkspaceSelection("ws-1");
    state = toggleWorkspaceSelection(state, "ws-2");
    const reconciled = reconcileWorkspaceSelection(state, new Set(["ws-1"]));
    expect({
      active: reconciled.active,
      selected: [...reconciled.selectedKeys],
      anchorKey: reconciled.anchorKey,
    }).toEqual({
      active: true,
      selected: ["ws-1"],
      anchorKey: null,
    });
  });

  it("resets completely on exit", () => {
    expect(exitWorkspaceSelection()).toBe(INITIAL_WORKSPACE_SELECTION_STATE);
  });

  it("detects Shift on direct, nativeEvent, or hardware modifier payloads", () => {
    expect(isShiftPressEvent({ shiftKey: true })).toBe(true);
    expect(isShiftPressEvent({ nativeEvent: { shiftKey: true } })).toBe(true);
    expect(isShiftPressEvent({ shiftKey: false, nativeEvent: { shiftKey: false } })).toBe(false);
    expect(isShiftPressEvent(null)).toBe(false);

    // Native GestureResponderEvent omits shiftKey; falls back to hardware Shift state.
    const nativeResponderEvent = { nativeEvent: { locationX: 12, locationY: 8 } };
    expect(isShiftPressEvent(nativeResponderEvent, () => false)).toBe(false);
    expect(isShiftPressEvent(nativeResponderEvent, () => true)).toBe(true);
  });
});

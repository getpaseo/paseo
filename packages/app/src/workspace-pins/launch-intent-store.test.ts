import { beforeEach, describe, expect, it } from "vitest";
import { useLaunchIntentStore } from "./launch-intent-store";

beforeEach(() => {
  useLaunchIntentStore.setState({ pending: null });
});

describe("launch intent store", () => {
  it("returns the requested target when the workspace key matches", () => {
    useLaunchIntentStore.getState().request({ workspaceKey: "ws-1", target: { kind: "terminal" } });
    expect(useLaunchIntentStore.getState().consume("ws-1")).toEqual({ kind: "terminal" });
  });

  it("clears the pending intent once consumed", () => {
    useLaunchIntentStore.getState().request({ workspaceKey: "ws-1", target: { kind: "draft" } });
    useLaunchIntentStore.getState().consume("ws-1");
    expect(useLaunchIntentStore.getState().pending).toBeNull();
  });

  it("returns null and keeps the intent when the workspace key does not match", () => {
    useLaunchIntentStore.getState().request({ workspaceKey: "ws-1", target: { kind: "browser" } });
    expect(useLaunchIntentStore.getState().consume("ws-2")).toBeNull();
    expect(useLaunchIntentStore.getState().pending).toEqual({
      workspaceKey: "ws-1",
      target: { kind: "browser" },
    });
  });

  it("returns null when there is no pending intent", () => {
    expect(useLaunchIntentStore.getState().consume("ws-1")).toBeNull();
  });
});

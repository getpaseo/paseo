import { beforeEach, describe, expect, it } from "vitest";
import {
  estimateTerminalViewportSize,
  rememberTerminalViewportSize,
  resetTerminalViewportSizeCacheForTests,
} from "./terminal-size-cache";

describe("terminal-size-cache", () => {
  beforeEach(() => {
    resetTerminalViewportSizeCacheForTests();
  });

  it("returns null before any size has been measured", () => {
    expect(estimateTerminalViewportSize({ serverId: "s1", cwd: "/repo" })).toBeNull();
  });

  it("returns the last measured size for the same workspace", () => {
    rememberTerminalViewportSize({ serverId: "s1", cwd: "/repo", size: { rows: 55, cols: 136 } });
    expect(estimateTerminalViewportSize({ serverId: "s1", cwd: "/repo" })).toEqual({
      rows: 55,
      cols: 136,
    });
  });

  it("falls back to the most recent size from another workspace", () => {
    rememberTerminalViewportSize({ serverId: "s1", cwd: "/repo-a", size: { rows: 40, cols: 100 } });
    // No terminal has been measured in /repo-b yet — the estimate uses the global most-recent size.
    expect(estimateTerminalViewportSize({ serverId: "s1", cwd: "/repo-b" })).toEqual({
      rows: 40,
      cols: 100,
    });
  });

  it("prefers the same-workspace size over the global most-recent", () => {
    rememberTerminalViewportSize({ serverId: "s1", cwd: "/repo-a", size: { rows: 40, cols: 100 } });
    rememberTerminalViewportSize({ serverId: "s1", cwd: "/repo-b", size: { rows: 55, cols: 136 } });
    // /repo-a keeps its own measured size even though /repo-b was measured more recently.
    expect(estimateTerminalViewportSize({ serverId: "s1", cwd: "/repo-a" })).toEqual({
      rows: 40,
      cols: 100,
    });
  });

  it("keys by server + cwd so different hosts do not collide", () => {
    rememberTerminalViewportSize({ serverId: "s1", cwd: "/repo", size: { rows: 40, cols: 100 } });
    rememberTerminalViewportSize({ serverId: "s2", cwd: "/repo", size: { rows: 55, cols: 136 } });
    expect(estimateTerminalViewportSize({ serverId: "s1", cwd: "/repo" })).toEqual({
      rows: 40,
      cols: 100,
    });
    expect(estimateTerminalViewportSize({ serverId: "s2", cwd: "/repo" })).toEqual({
      rows: 55,
      cols: 136,
    });
  });
});

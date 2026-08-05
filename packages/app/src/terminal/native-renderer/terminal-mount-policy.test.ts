import { describe, expect, it } from "vitest";

import { resolveNativeTerminalMountAction } from "./terminal-mount-policy";

describe("native terminal mount policy", () => {
  it("does not remount when a snapshot changes within the same stream", () => {
    expect(
      resolveNativeTerminalMountAction({
        mountedStreamKey: "terminal:1",
        nextStreamKey: "terminal:1",
      }),
    ).toEqual("keep");
  });

  it("mounts the first stream and remounts when the stream changes", () => {
    expect(
      resolveNativeTerminalMountAction({
        mountedStreamKey: null,
        nextStreamKey: "terminal:1",
      }),
    ).toEqual("mount");
    expect(
      resolveNativeTerminalMountAction({
        mountedStreamKey: "terminal:1",
        nextStreamKey: "terminal:2",
      }),
    ).toEqual("mount");
  });
});

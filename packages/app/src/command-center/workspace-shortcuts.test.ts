import { describe, expect, it } from "vitest";
import { resolveWorkspaceCommandCenterShortcuts } from "./workspace-shortcuts";

describe("resolveWorkspaceCommandCenterShortcuts", () => {
  it("assigns the New agent command its own shortcut", () => {
    expect(
      resolveWorkspaceCommandCenterShortcuts({
        overrides: {},
        platform: { isMac: true, isDesktop: true },
      }).newAgent,
    ).toEqual([["mod", "shift", "A"]]);
  });
});

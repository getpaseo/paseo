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

it("shows user-assigned rename keys in the command palette", () => {
  const shortcuts = resolveWorkspaceCommandCenterShortcuts({
    overrides: {
      "workspace-rename": "Cmd+Alt+Shift+R",
      "workspace-tab-rename-current": "Cmd+Alt+R",
    },
    platform: { isMac: true, isDesktop: true },
  });
  expect(shortcuts.renameWorkspace).toEqual([["mod", "alt", "shift", "R"]]);
  expect(shortcuts.renameCurrentTab).toEqual([["mod", "alt", "R"]]);
});

import { describe, expect, it } from "vitest";
import {
  retainVisibleSidebarWorkspaceSelection,
  shouldToggleSidebarWorkspacePin,
  toggleSidebarWorkspaceSelection,
} from "./sidebar-workspace-selection";

describe("sidebar workspace selection", () => {
  it("toggles one workspace without changing the other selected keys", () => {
    expect(toggleSidebarWorkspaceSelection(new Set(["srv:one"]), "srv:two")).toEqual(
      new Set(["srv:one", "srv:two"]),
    );
    expect(toggleSidebarWorkspaceSelection(new Set(["srv:one", "srv:two"]), "srv:one")).toEqual(
      new Set(["srv:two"]),
    );
  });

  it("removes selections hidden by a project filter", () => {
    expect(
      retainVisibleSidebarWorkspaceSelection(
        new Set(["srv:one", "srv:two"]),
        new Set(["srv:two", "srv:three"]),
      ),
    ).toEqual(new Set(["srv:two"]));
  });

  it("reserves Shift-click pinning for desktop rows outside select mode", () => {
    expect(
      shouldToggleSidebarWorkspacePin({
        selectionMode: false,
        isElectron: true,
        shiftKey: true,
        canPin: true,
      }),
    ).toBe(true);
    expect(
      shouldToggleSidebarWorkspacePin({
        selectionMode: true,
        isElectron: true,
        shiftKey: true,
        canPin: true,
      }),
    ).toBe(false);
    expect(
      shouldToggleSidebarWorkspacePin({
        selectionMode: false,
        isElectron: false,
        shiftKey: true,
        canPin: true,
      }),
    ).toBe(false);
  });
});

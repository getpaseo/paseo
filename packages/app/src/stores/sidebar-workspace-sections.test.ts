import { describe, expect, it } from "vitest";
import {
  moveWorkspaceToSection,
  moveWorkspacesToSection,
  normalizeWorkspaceSections,
  removeWorkspaceSection,
  renameWorkspaceSection,
  reorderWorkspaceSections,
} from "./sidebar-workspace-sections";

describe("workspace sections", () => {
  it("normalizes names, ids, and workspace placement", () => {
    expect(
      normalizeWorkspaceSections([
        { id: " finance ", name: " Finance ", workspaceKeys: ["srv:one", "srv:one", ""] },
        { id: "research", name: "Research", workspaceKeys: ["srv:one", "srv:two"] },
      ]),
    ).toEqual([
      { id: "finance", name: "Finance", workspaceKeys: ["srv:one"] },
      { id: "research", name: "Research", workspaceKeys: ["srv:two"] },
    ]);
  });

  it("moves one or many workspaces and returns deleted-section workspaces to Unsectioned", () => {
    const sections = [
      { id: "finance", name: "Finance", workspaceKeys: ["srv:one"] },
      { id: "research", name: "Research", workspaceKeys: ["srv:two"] },
    ];
    const movedOne = moveWorkspaceToSection(sections, "srv:one", "research");
    expect(movedOne).toEqual([
      { id: "finance", name: "Finance", workspaceKeys: [] },
      { id: "research", name: "Research", workspaceKeys: ["srv:two", "srv:one"] },
    ]);

    const movedMany = moveWorkspacesToSection(movedOne, ["srv:two", "srv:one"], "finance");
    expect(removeWorkspaceSection(movedMany, "finance")).toEqual([
      { id: "research", name: "Research", workspaceKeys: [] },
    ]);
  });

  it("renames and reorders empty sections", () => {
    const sections = [
      { id: "finance", name: "Finance", workspaceKeys: [] },
      { id: "research", name: "Research", workspaceKeys: [] },
    ];
    expect(
      reorderWorkspaceSections(renameWorkspaceSection(sections, "finance", "Waiting"), [
        "research",
        "finance",
      ]),
    ).toMatchObject([
      { name: "Research", workspaceKeys: [] },
      { name: "Waiting", workspaceKeys: [] },
    ]);
  });
});

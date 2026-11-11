import { describe, expect, it } from "vitest";
import {
  mergeSectionOrderIntoProjectOrder,
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

describe("mergeSectionOrderIntoProjectOrder", () => {
  it("keeps the rows a section does not show and every other row in place", () => {
    expect(
      mergeSectionOrderIntoProjectOrder({
        projectOrder: ["srv:u1", "srv:s1", "srv:u2", "srv:s2", "srv:u3", "srv:s3"],
        sectionWorkspaceKeys: ["srv:s1", "srv:s2", "srv:s3"],
        reorderedWorkspaceKeys: ["srv:s2", "srv:s1"],
      }),
    ).toEqual(["srv:u1", "srv:s2", "srv:u2", "srv:s1", "srv:u3", "srv:s3"]);
  });

  it("retains the hidden rows of a section that is past the row limit", () => {
    const sectionKeys = Array.from({ length: 9 }, (_, index) => `srv:s${index + 1}`);
    expect(
      mergeSectionOrderIntoProjectOrder({
        projectOrder: sectionKeys,
        sectionWorkspaceKeys: sectionKeys,
        reorderedWorkspaceKeys: ["srv:s7", ...sectionKeys.slice(0, 6)],
      }),
    ).toEqual(["srv:s7", ...sectionKeys.slice(0, 6), "srv:s8", "srv:s9"]);
  });

  it("appends section rows the project order has not caught up with yet", () => {
    expect(
      mergeSectionOrderIntoProjectOrder({
        projectOrder: ["srv:u1", "srv:s1"],
        sectionWorkspaceKeys: ["srv:s1", "srv:s2"],
        reorderedWorkspaceKeys: ["srv:s2", "srv:s1"],
      }),
    ).toEqual(["srv:u1", "srv:s2", "srv:s1"]);
  });
});

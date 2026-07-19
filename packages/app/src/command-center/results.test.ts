import { describe, expect, it } from "vitest";
import type { CommandCenterContribution } from "./contributions";
import {
  buildContributionSections,
  moveActiveResultId,
  preserveActiveResultId,
  projectCommandCenterRows,
  type CommandCenterWorkspaceResult,
} from "./results";

function contribution(input: {
  id: string;
  group: string;
  groupRank: number;
  visibility?: "always" | "query";
}): CommandCenterContribution {
  return {
    ...input,
    rank: 0,
    keywords: [input.id],
    visibility: input.visibility ?? "always",
    run: () => undefined,
    presentation: {
      kind: "action",
      title: input.id,
      sectionTitle: input.group,
    },
  };
}

function workspace(id: string): CommandCenterWorkspaceResult {
  return {
    kind: "workspace",
    id,
    title: id,
    subtitle: "host",
    searchText: id,
    run: () => undefined,
  };
}

function sectionResultIds(sections: ReturnType<typeof buildContributionSections>): string[] {
  const ids: string[] = [];
  for (const section of sections) {
    for (const result of section.results) ids.push(result.id);
  }
  return ids;
}

describe("Command Center result projection", () => {
  it("query-gates model choices and creates one flat row index", () => {
    const contributions = [
      contribution({ id: "settings", group: "actions", groupRank: 0 }),
      contribution({ id: "opus", group: "models", groupRank: 1, visibility: "query" }),
    ];
    const emptySections = buildContributionSections(contributions, "");
    expect(sectionResultIds(emptySections)).toEqual(["settings"]);

    const sections = buildContributionSections(contributions, "o");
    const projection = projectCommandCenterRows([
      ...sections,
      { id: "workspaces", rank: 2, title: "Workspaces", results: [workspace("workspace:1")] },
    ]);
    expect(projection.rows.map((row) => row.key)).toEqual([
      "section:models",
      "opus",
      "section:workspaces",
      "workspace:1",
    ]);
    expect(projection.rowIndexByResultId.get("workspace:1")).toBe(3);
    expect(projection.offsets).toEqual([0, 32, 68, 117]);
  });

  it("preserves active selection by id and falls back to the first result", () => {
    const first = workspace("workspace:first");
    const second = workspace("workspace:second");
    expect(preserveActiveResultId(second.id, [first, second])).toBe(second.id);
    expect(preserveActiveResultId("missing", [first, second])).toBe(first.id);
    expect(preserveActiveResultId(first.id, [])).toBeNull();
  });

  it("wraps keyboard selection in both directions", () => {
    const first = workspace("workspace:first");
    const second = workspace("workspace:second");
    expect(moveActiveResultId(second.id, [first, second], "next")).toBe(first.id);
    expect(moveActiveResultId(first.id, [first, second], "previous")).toBe(second.id);
  });

  it("keeps keyboard selection aligned with rows beyond the render window", () => {
    const workspaces = Array.from({ length: 200 }, (_, index) => workspace(`workspace:${index}`));
    const projection = projectCommandCenterRows([
      { id: "workspaces", rank: 0, title: "Workspaces", results: workspaces },
    ]);

    let activeId: string | null = workspaces[0].id;
    for (let index = 0; index < 150; index += 1) {
      activeId = moveActiveResultId(activeId, projection.selectableResults, "next");
    }

    const targetId = workspaces[150].id;
    expect(activeId).toBe(targetId);
    expect(projection.rowIndexByResultId.get(targetId)).toBe(151);
    expect(projection.offsets[151]).toBe(32 + 150 * 56);
  });
});

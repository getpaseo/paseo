import { describe, expect, it } from "vitest";
import type { SidebarGroupMode } from "@/stores/sidebar-view-store";
import type { CommandCenterIconProps } from "./contributions";
import { buildGroupingContribution, type GroupingCommandCenterSource } from "./root-contributions";

function ProjectIcon(_props: CommandCenterIconProps) {
  return null;
}

function StatusIcon(_props: CommandCenterIconProps) {
  return null;
}

function source(groupMode: SidebarGroupMode): {
  value: GroupingCommandCenterSource;
  applied: SidebarGroupMode[];
} {
  const applied: SidebarGroupMode[] = [];
  return {
    value: {
      groupMode,
      labels: {
        section: "Actions",
        groupByProject: "Group by project",
        groupByStatus: "Group by status",
      },
      icons: { project: ProjectIcon, status: StatusIcon },
      setGroupMode: (mode) => applied.push(mode),
    },
    applied,
  };
}

describe("grouping command center contribution", () => {
  it("offers status while grouped by project", () => {
    const fixture = source("project");
    const contribution = buildGroupingContribution(fixture.value);

    expect(contribution.presentation).toMatchObject({
      title: "Group by status",
      icon: StatusIcon,
    });

    contribution.run();
    expect(fixture.applied).toEqual(["status"]);
  });

  it("offers project while grouped by status", () => {
    const fixture = source("status");
    const contribution = buildGroupingContribution(fixture.value);

    expect(contribution.presentation).toMatchObject({
      title: "Group by project",
      icon: ProjectIcon,
    });

    contribution.run();
    expect(fixture.applied).toEqual(["project"]);
  });

  it("keeps a stable id across both modes so the registry tiebreak never moves", () => {
    expect(buildGroupingContribution(source("project").value).id).toBe(
      buildGroupingContribution(source("status").value).id,
    );
  });

  it("stays out of the default empty-query list", () => {
    for (const mode of ["project", "status"] as const) {
      const contribution = buildGroupingContribution(source(mode).value);
      expect(contribution.visibility).toBe("query");
      expect(contribution.group).toBe("actions");
      // 6 is keyboard-shortcuts and 7 belongs to the workspace actions in #3013.
      expect(contribution.rank).toBe(8);
    }
  });
});

import type { SidebarGroupMode } from "@/stores/sidebar-view-store";
import type { CommandCenterContribution, CommandCenterIcon } from "./contributions";

export interface GroupingCommandCenterSource {
  groupMode: SidebarGroupMode;
  labels: {
    section: string;
    groupByProject: string;
    groupByStatus: string;
  };
  icons: {
    project?: CommandCenterIcon;
    status?: CommandCenterIcon;
  };
  setGroupMode(mode: SidebarGroupMode): void;
}

// One entry that always names the mode you are not in, so it can never read as a no-op.
export function buildGroupingContribution(
  source: GroupingCommandCenterSource,
): CommandCenterContribution {
  // Collapse into nextGroupMode() from sidebar-view-store once #2504 lands.
  const target: SidebarGroupMode = source.groupMode === "project" ? "status" : "project";
  return {
    id: "sidebar-grouping",
    group: "actions",
    groupRank: 0,
    rank: 8,
    keywords: ["group", "grouping", "sort", "sidebar", "project", "status"],
    visibility: "query",
    run: () => source.setGroupMode(target),
    presentation: {
      kind: "action",
      title: target === "status" ? source.labels.groupByStatus : source.labels.groupByProject,
      sectionTitle: source.labels.section,
      icon: target === "status" ? source.icons.status : source.icons.project,
    },
  };
}

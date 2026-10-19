import type { SidebarGroupMode } from "@/stores/sidebar-view-store";
import type { CommandCenterContribution, CommandCenterIcon } from "./contributions";

export interface GroupingCommandCenterSource {
  groupMode: SidebarGroupMode;
  labels: {
    section: string;
    groupByProject: string;
    groupByStatus: string;
    groupByDay: string;
  };
  icons: {
    project?: CommandCenterIcon;
    status?: CommandCenterIcon;
    day?: CommandCenterIcon;
  };
  setGroupMode(mode: SidebarGroupMode): void;
}

const NEXT_GROUP_MODE: Record<SidebarGroupMode, SidebarGroupMode> = {
  project: "status",
  status: "day",
  day: "project",
};

// One entry that names the next mode in the cycle, so it can never read as a no-op.
export function buildGroupingContribution(
  source: GroupingCommandCenterSource,
): CommandCenterContribution {
  // Collapse into nextGroupMode() from sidebar-view-store once #2504 lands.
  const target = NEXT_GROUP_MODE[source.groupMode];
  const title = groupModeLabel(target, source.labels);
  const icon = groupModeIcon(target, source.icons);
  return {
    id: "sidebar-grouping",
    group: "actions",
    groupRank: 0,
    rank: 8,
    keywords: ["group", "grouping", "sort", "sidebar", "project", "status", "day"],
    visibility: "query",
    run: () => source.setGroupMode(target),
    presentation: {
      kind: "action",
      title,
      sectionTitle: source.labels.section,
      icon,
    },
  };
}

function groupModeLabel(
  mode: SidebarGroupMode,
  labels: GroupingCommandCenterSource["labels"],
): string {
  if (mode === "status") return labels.groupByStatus;
  if (mode === "day") return labels.groupByDay;
  return labels.groupByProject;
}

function groupModeIcon(
  mode: SidebarGroupMode,
  icons: GroupingCommandCenterSource["icons"],
): CommandCenterIcon | undefined {
  if (mode === "status") return icons.status;
  if (mode === "day") return icons.day;
  return icons.project;
}

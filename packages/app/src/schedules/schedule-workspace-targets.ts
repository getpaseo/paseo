import type { ProjectSummary } from "@/utils/projects";
import { buildProjectOptionId } from "./schedule-project-targets";

export const NEW_SCHEDULE_WORKSPACE_OPTION_ID = "new-workspace-each-run";

export interface ScheduleWorkspaceTarget {
  workspaceId: string;
  serverId: string;
  projectOptionId: string;
  workspaceName: string;
  cwd: string;
}

export function buildScheduleWorkspaceTargets(
  projects: readonly ProjectSummary[],
): ScheduleWorkspaceTarget[] {
  return projects.flatMap((project) =>
    project.hosts.flatMap((host) => {
      if (!host.isOnline) {
        return [];
      }
      return host.workspaces.flatMap((workspace) => {
        const cwd = workspace.workspaceDirectory?.trim() ?? "";
        if (!cwd || workspace.archivingAt) {
          return [];
        }
        return [
          {
            workspaceId: workspace.id,
            serverId: host.serverId,
            projectOptionId: buildProjectOptionId(host.serverId, project.viewKey),
            workspaceName: workspace.title?.trim() || workspace.name,
            cwd,
          },
        ];
      });
    }),
  );
}

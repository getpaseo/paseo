import type { PluginProjectSnapshot } from "@getpaseo/plugin";
import type { ProjectSummary } from "@/utils/projects";

export function toPluginProjectSnapshots(
  projects: readonly ProjectSummary[],
): readonly PluginProjectSnapshot[] {
  return Object.freeze(
    projects.map((project) =>
      Object.freeze({
        projectKey: project.viewKey,
        projectName: project.projectCustomName ?? project.projectName,
        placements: Object.freeze(
          project.hosts.map((placement) =>
            Object.freeze({
              serverId: placement.serverId,
              serverName: placement.serverName,
              projectId: placement.projectId,
              projectName: placement.projectCustomName ?? placement.projectName,
              projectRootPath: placement.repoRoot,
              projectKind: placement.projectKind,
              isOnline: placement.isOnline,
            }),
          ),
        ),
      }),
    ),
  );
}

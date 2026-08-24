import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";

type WorkspaceScript = SidebarWorkspaceEntry["scripts"][number];

/**
 * The one running service a row reports, by name.
 *
 * Services only. A workspace also runs plain commands — test watchers, build steps — and those
 * are not what the row is for: they start and finish on their own and say nothing about whether
 * the workspace is up. The name rather than the port because the name is what you called it, and
 * a row that reads "web" tells you more than one that reads ":3000".
 */
export interface WorkspaceServiceSummary {
  name: string;
  health: WorkspaceScript["health"];
}

/**
 * A workspace can run several services and the row has space for one, so a failing one wins: a
 * healthy service is the unremarkable case and any of them will do to say "this is up", while an
 * unhealthy one is the only thing on the line you would act on.
 */
export function selectWorkspaceServiceSummary(
  scripts: SidebarWorkspaceEntry["scripts"],
): WorkspaceServiceSummary | null {
  let firstHealthy: WorkspaceServiceSummary | null = null;
  for (const script of scripts) {
    if (script.lifecycle !== "running") continue;
    if ((script.type ?? "service") !== "service") continue;

    const summary: WorkspaceServiceSummary = { name: script.scriptName, health: script.health };
    if (script.health === "unhealthy") {
      return summary;
    }
    firstHealthy ??= summary;
  }
  return firstHealthy;
}

/**
 * The accessible name for a service, as a key both the meta row and the row's own accessibility
 * label read. Health is the whole difference between them, so it is decided once here rather than
 * at each call site.
 */
export function workspaceServiceLabelKey(summary: WorkspaceServiceSummary): string {
  return summary.health === "unhealthy"
    ? "workspace.status.serviceUnhealthy"
    : "workspace.status.serviceRunning";
}

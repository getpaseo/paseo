import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";

type WorkspaceScript = SidebarWorkspaceEntry["scripts"][number];

export interface WorkspaceServiceSummary {
  name: string;
  health: WorkspaceScript["health"];
  type: "service" | "script";
  otherScripts: string[];
}

/** Show one service (a failing one first) alongside every running regular script. */
export function selectWorkspaceServiceSummary(
  scripts: SidebarWorkspaceEntry["scripts"],
): WorkspaceServiceSummary | null {
  let service: WorkspaceScript | null = null;
  const commands: string[] = [];
  for (const script of scripts) {
    if (script.lifecycle !== "running") continue;
    if (script.type === "script") {
      const packageJson = script.packageJson;
      let name = script.scriptName;
      if (packageJson) {
        const directory = packageJson.path.slice(0, -"package.json".length);
        name = directory ? `${directory}${packageJson.script}` : packageJson.script;
      }
      commands.push(name);
    } else if (!service || script.health === "unhealthy") {
      service = script;
    }
  }
  if (service)
    return {
      name: service.scriptName,
      health: service.health,
      type: "service",
      otherScripts: commands,
    };
  const [name, ...otherScripts] = commands;
  return name === undefined ? null : { name, health: null, type: "script", otherScripts };
}

export function workspaceServiceLabelKey(summary: WorkspaceServiceSummary): string {
  if (summary.type === "script") return "sidebar.workspace.status.scriptRunning";
  return summary.health === "unhealthy"
    ? "sidebar.workspace.status.serviceUnhealthy"
    : "sidebar.workspace.status.serviceRunning";
}

import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";

/**
 * The one running script a row reports. A workspace can run several; the row has space for
 * one item, and a service (something reachable on a port) is the one worth surfacing, so a
 * running service outranks a running command.
 */
export interface WorkspaceScriptSummary {
  kind: "service" | "command";
  /** Only a service binds a port, and only then when the daemon has observed it. */
  port: number | null;
}

export function selectWorkspaceScriptSummary(
  scripts: SidebarWorkspaceEntry["scripts"],
): WorkspaceScriptSummary | null {
  let command: WorkspaceScriptSummary | null = null;
  for (const script of scripts) {
    if (script.lifecycle !== "running") continue;
    if ((script.type ?? "service") === "service") {
      return { kind: "service", port: script.port };
    }
    command ??= { kind: "command", port: null };
  }
  return command;
}

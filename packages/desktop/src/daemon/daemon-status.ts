import type { DaemonInstance } from "@getpaseo/server/daemon-control";
import type { DesktopDaemonStatus } from "./daemon-manager.js";

export function statusFromDaemonProbe(
  payload: Record<string, unknown>,
  home: string,
  ownedLaunch: { home: string; instance: DaemonInstance } | null,
): DesktopDaemonStatus {
  const local = typeof payload.localDaemon === "string" ? payload.localDaemon : "stopped";
  const processAlive = local === "running" || local === "not_ready";
  let status: DesktopDaemonStatus["status"] = "stopped";
  if (local === "not_ready") status = "starting";
  if (local === "running") status = "running";
  const authenticationFailed =
    payload.connectedDaemon === "auth_required" || payload.connectedDaemon === "auth_failed";
  let error: string | null = null;
  if (authenticationFailed) {
    error = typeof payload.note === "string" ? payload.note : "Daemon authentication failed.";
  }
  return {
    serverId: typeof payload.serverId === "string" ? payload.serverId : "",
    status,
    listen: typeof payload.listen === "string" ? payload.listen : null,
    hostname:
      status === "running" && typeof payload.hostname === "string" ? payload.hostname : null,
    pid: processAlive && typeof payload.pid === "number" ? payload.pid : null,
    home,
    version: typeof payload.daemonVersion === "string" ? payload.daemonVersion : null,
    desktopManaged: payload.desktopManaged === true,
    startedAt: typeof payload.startedAt === "string" ? payload.startedAt : null,
    ownedByDesktop: Boolean(
      ownedLaunch &&
      ownedLaunch.home === home &&
      payload.pid === ownedLaunch.instance.pid &&
      payload.startedAt === ownedLaunch.instance.startedAt,
    ),
    error,
  };
}

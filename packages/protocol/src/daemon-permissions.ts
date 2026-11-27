import { z } from "zod";

export const DAEMON_PERMISSIONS = [
  "daemon.read",
  "daemon.manage",
  "tunnel.manage",
  "access.manage",
  "workspace.read",
  "workspace.write",
  "workspace.manage",
  "automation.manage",
  "hub.execute",
] as const;
export const DaemonPermissionSchema = z.enum(DAEMON_PERMISSIONS);
export type DaemonPermission = z.infer<typeof DaemonPermissionSchema>;

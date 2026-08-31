import type { WorkspaceDescriptor } from "@/stores/session-store";

export function canManageWorkspaceLaunches(input: {
  daemonAdvertisesSupport: boolean;
  launchDescriptor: WorkspaceDescriptor["launches"];
}): boolean {
  if (input.daemonAdvertisesSupport) return true;

  // COMPAT(workspaceLaunchManagement): added in v0.7.0, remove after 2027-08-29 once the
  // supported daemon floor is >= v0.7.0. A descriptor that explicitly includes `launches` is
  // emitted only by a launch-capable daemon. It remains valid if a long-lived app connection
  // has not yet refreshed its server_info handshake after a daemon update.
  return input.launchDescriptor !== undefined;
}

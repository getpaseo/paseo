export const CLIENT_SHUTDOWN_RPC_REASON = "client_shutdown_rpc";
export const DEFAULT_CLIENT_RESTART_RPC_REASON = "client_restart_rpc";
export const DAEMON_UPDATE_RPC_REASON = "daemon_update";

export function normalizeClientRestartRpcReason(reason: string | undefined): string {
  return reason?.trim() || DEFAULT_CLIENT_RESTART_RPC_REASON;
}

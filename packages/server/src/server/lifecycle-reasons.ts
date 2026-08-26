export const CLIENT_SHUTDOWN_RPC_REASON = "client_shutdown_rpc";
export const DEFAULT_CLIENT_RESTART_RPC_REASON = "client_restart_rpc";

export function normalizeClientRestartRpcReason(reason: string | undefined): string {
  return reason?.trim() || DEFAULT_CLIENT_RESTART_RPC_REASON;
}

export function isExpectedShutdownCancellation(
  error: unknown,
  options: { processSignalExpected?: boolean } = {},
): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError") return true;
  return options.processSignalExpected === true && /\bSIG(?:INT|TERM)\b/.test(error.message);
}

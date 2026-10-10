import type { DaemonAuthFailureReason } from "@getpaseo/client/internal/daemon-client";

/** Preserve the daemon probe failure and authentication reason for setup forms. */
export class DaemonConnectionTestError extends Error {
  reason: string | null;
  lastError: string | null;
  authFailureReason: DaemonAuthFailureReason | null;

  constructor(
    message: string,
    details: {
      reason: string | null;
      lastError: string | null;
      authFailureReason?: DaemonAuthFailureReason | null;
    },
  ) {
    super(message);
    this.name = "DaemonConnectionTestError";
    this.reason = details.reason;
    this.lastError = details.lastError;
    this.authFailureReason = details.authFailureReason ?? null;
  }
}

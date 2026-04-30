/**
 * Structured failure for daemon startup. Surfaced via the IPC bridge so the
 * splash screen can render targeted UI (e.g. "another process is using port
 * 6767, end it and try again") instead of a raw stack trace.
 */
export type DaemonStartErrorCode =
  | "STALE_HUBCODE_DAEMON"
  | "PORT_TAKEN_BY_OTHER"
  | "STARTUP_FAILED";

export interface DaemonStartErrorDetails {
  port?: number | null;
  conflictingPid?: number | null;
  conflictingProcessName?: string | null;
  conflictingDaemonVersion?: string | null;
  recentLogs?: string;
}

export class DaemonStartError extends Error {
  readonly code: DaemonStartErrorCode;
  readonly details: DaemonStartErrorDetails;

  constructor(code: DaemonStartErrorCode, message: string, details: DaemonStartErrorDetails = {}) {
    super(message);
    this.name = "DaemonStartError";
    this.code = code;
    this.details = details;
  }

  // The Electron IPC bridge can't transport class instances over the wire. We
  // serialize to a plain object the renderer can recognize via the
  // `__hubcodeDaemonStartError` marker.
  toIpcPayload(): {
    __hubcodeDaemonStartError: true;
    code: DaemonStartErrorCode;
    message: string;
    details: DaemonStartErrorDetails;
  } {
    return {
      __hubcodeDaemonStartError: true,
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

export function isDaemonStartError(value: unknown): value is DaemonStartError {
  return value instanceof DaemonStartError;
}

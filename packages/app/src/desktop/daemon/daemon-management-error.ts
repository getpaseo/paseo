export class DaemonConnectionRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonConnectionRegistrationError";
  }
}

export class DaemonManagementOperationError extends Error {
  readonly originalError: Error;
  readonly wasManagingDaemon: boolean;

  constructor(error: Error, wasManagingDaemon: boolean) {
    super(error.message);
    this.name = error.name;
    this.cause = error;
    this.originalError = error;
    this.wasManagingDaemon = wasManagingDaemon;
  }
}

export interface DaemonManagementErrorPresentation {
  message: string;
  refreshStatus: boolean;
}

export function getDaemonManagementErrorPresentation(
  error: Error,
  isManagingDaemon: boolean,
): DaemonManagementErrorPresentation {
  const presentationError =
    error instanceof DaemonManagementOperationError ? error.originalError : error;
  const wasManagingDaemon =
    error instanceof DaemonManagementOperationError ? error.wasManagingDaemon : isManagingDaemon;

  if (presentationError instanceof DaemonConnectionRegistrationError) {
    return {
      message:
        "Built-in daemon started, but Paseo could not save the localhost connection. Toggle daemon management off and on again, or add localhost manually.",
      refreshStatus: true,
    };
  }
  if (wasManagingDaemon) {
    return {
      message: "Built-in daemon management was paused, but Paseo could not stop the daemon.",
      refreshStatus: false,
    };
  }
  return {
    message: "Unable to update built-in daemon management.",
    refreshStatus: false,
  };
}

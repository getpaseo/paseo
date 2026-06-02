import { i18n } from "@/i18n/i18next";

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
      message: i18n.t("desktop.daemon.management.registrationFailed"),
      refreshStatus: true,
    };
  }
  if (wasManagingDaemon) {
    return {
      message: i18n.t("desktop.daemon.management.pausedStopFailed"),
      refreshStatus: false,
    };
  }
  return {
    message: i18n.t("desktop.daemon.management.updateFailed"),
    refreshStatus: false,
  };
}

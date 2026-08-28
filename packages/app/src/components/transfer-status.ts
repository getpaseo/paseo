import type { TFunction } from "i18next";

export interface TransferProgress {
  percent: number;
  bytesWritten: number;
  totalBytes: number;
  speed: number;
  eta: number;
}

/**
 * One toast serves both directions. A transfer is whichever of the two stores currently has
 * something in flight; downloads win a tie because the user just asked for one.
 */
export interface Transfer {
  id: string;
  fileName: string;
  inFlight: boolean;
  complete: boolean;
  message?: string;
  progress?: TransferProgress;
  dismiss: () => void;
  /** Present only while in flight: aborts the transfer and tells the daemon to stop. */
  cancel?: () => void;
}

export function getTransferStatusText(transfer: Transfer, isUpload: boolean, t: TFunction): string {
  if (transfer.inFlight) {
    if (transfer.progress) {
      // A streamed archive has no length until it is written, so percent and ETA would read
      // "0% · < 1s" for the whole transfer. Report what is actually known instead.
      if (transfer.progress.totalBytes <= 0) {
        return `${formatBytes(transfer.progress.bytesWritten)} · ${formatSpeed(transfer.progress.speed)}`;
      }
      return `${Math.round(transfer.progress.percent * 100)}% · ${formatSpeed(transfer.progress.speed)} · ${formatEta(transfer.progress.eta)}`;
    }
    return t("common.states.starting");
  }
  if (transfer.complete) {
    return t(isUpload ? "common.states.uploadComplete" : "common.states.downloadComplete");
  }
  return (
    transfer.message ?? t(isUpload ? "common.states.uploadFailed" : "common.states.downloadFailed")
  );
}

/** A determinate bar is meaningless without a total. */
export function hasDeterminateProgress(transfer: Transfer): boolean {
  return transfer.inFlight && transfer.progress !== undefined && transfer.progress.totalBytes > 0;
}

export function formatSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond < 1024) {
    return `${Math.round(bytesPerSecond)} B/s`;
  }
  if (bytesPerSecond < 1024 * 1024) {
    return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
  }
  return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function formatEta(seconds: number): string {
  if (seconds < 1) {
    return "< 1s";
  }
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m ${secs}s`;
}

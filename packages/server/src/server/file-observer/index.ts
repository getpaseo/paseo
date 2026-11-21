import type { CreateObservationBackend } from "./internal/contracts.js";
import { createLinuxBackend } from "./internal/linux.js";
import { createNativeRecursiveBackend } from "./internal/native-recursive.js";
import { createObserverPaths } from "./internal/paths.js";
import { FileObserverService } from "./internal/service.js";

export type FileChangeType = "create" | "update" | "delete";

export interface FileChange {
  path: string;
  type: FileChangeType;
}

export interface FileObserverOptions {
  ignore?: string[];
  // Aborting before `subscribe()` resolves stops the startup scan and rejects with the reason.
  signal?: AbortSignal;
}

export type FileObserverCallback = (error: Error | null, events: FileChange[]) => void;

export interface FileObserverSubscription {
  updateIgnore(paths: string[]): Promise<void>;
  unsubscribe(): Promise<void>;
}

export interface FileObserverDiagnostics {
  activeObservationCount: number;
  nativeHandleCount: number;
  nativeTrackedFileCount: number;
  pendingEventCount: number;
  pendingReconciliationWorkCount: number;
  pendingClassificationCount: number;
  reconciliationInFlightCount: number;
  reconciliationCount: number;
  scopedReconciliationCount: number;
  fullReconciliationCount: number;
  reconciliationFailureCount: number;
  observerFailureCount: number;
  directoryLimitFailureCount: number;
  nativeEventCount: number;
  nativeChangeEventCount: number;
  nativeRenameEventCount: number;
  nativePathlessEventCount: number;
  nativeClassificationCount: number;
  nativeShallowScanCount: number;
  lastReconciliationDurationMs: number;
  maxReconciliationDurationMs: number;
}

export interface FileObserver {
  subscribe(
    directory: string,
    callback: FileObserverCallback,
    options?: FileObserverOptions,
  ): Promise<FileObserverSubscription>;
  getDiagnostics(): FileObserverDiagnostics;
  close(): Promise<void>;
}

export type SubscribeToFileChanges = FileObserver["subscribe"];

export function createFileObserver(): FileObserver {
  const platform = process.platform;
  const paths = createObserverPaths(platform);
  const createBackend: CreateObservationBackend =
    platform === "darwin" || platform === "win32"
      ? (host) => createNativeRecursiveBackend(host, paths)
      : (host) => createLinuxBackend(host, paths);
  return new FileObserverService(createBackend, paths);
}

import type { FileChangeType, FileObserverDiagnostics } from "../index.js";

export interface ObserverMetrics extends Omit<
  FileObserverDiagnostics,
  | "activeObservationCount"
  | "nativeHandleCount"
  | "nativeTrackedFileCount"
  | "pendingEventCount"
  | "pendingReconciliationWorkCount"
  | "reconciliationInFlightCount"
> {}

export interface BackendDiagnostics {
  nativeHandleCount: number;
  nativeTrackedFileCount: number;
  pendingReconciliationWorkCount: number;
  reconciliationInFlight: boolean;
}

export interface ObservationBackend {
  start(): Promise<void>;
  updateIgnore(): Promise<void>;
  close(): Promise<void>;
  getDiagnostics(): BackendDiagnostics;
}

export interface ObservationHost {
  root: string;
  metrics: ObserverMetrics;
  isActive(): boolean;
  isIgnored(path: string): boolean;
  isPathInside(root: string, path: string): boolean;
  queueEvent(type: FileChangeType, path: string): void;
  fail(error: Error): void;
}

export type CreateObservationBackend = (host: ObservationHost) => ObservationBackend;

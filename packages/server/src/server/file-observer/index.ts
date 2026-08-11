import { resolve } from "node:path";
import type { CreateObservationBackend, ObserverMetrics } from "./internal/contracts.js";
import { createLinuxBackend } from "./internal/linux.js";
import { createNativeRecursiveBackend } from "./internal/native-recursive.js";
import { createManagedObservation, type ManagedObservation } from "./internal/observation.js";
import { createObserverPaths } from "./internal/paths.js";

export type FileChangeType = "create" | "update" | "delete";

export interface FileChange {
  path: string;
  type: FileChangeType;
}

export interface FileObserverOptions {
  ignore?: string[];
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

class FileObserverService implements FileObserver {
  private state:
    | {
        status: "open";
        observations: Set<ManagedObservation>;
        metrics: ObserverMetrics;
      }
    | { status: "closed" } = {
    status: "open",
    observations: new Set(),
    metrics: createObserverMetrics(),
  };
  private closePromise: Promise<void> | null = null;

  constructor(
    private readonly createBackend: CreateObservationBackend,
    private readonly paths: ReturnType<typeof createObserverPaths>,
  ) {}

  async subscribe(
    directory: string,
    callback: FileObserverCallback,
    options: FileObserverOptions = {},
  ): Promise<FileObserverSubscription> {
    if (this.state.status === "closed") throw new Error("File observer is closed");
    const state = this.state;
    let observation!: ManagedObservation;
    observation = createManagedObservation({
      root: resolve(directory),
      callback,
      options,
      paths: this.paths,
      metrics: state.metrics,
      createBackend: this.createBackend,
      onClosed: () => state.observations.delete(observation),
    });
    await observation.start();
    if (this.closePromise) {
      await observation.close();
      throw new Error("File observer is closed");
    }
    state.observations.add(observation);
    return observation.subscription();
  }

  getDiagnostics(): FileObserverDiagnostics {
    if (this.state.status === "closed") return emptyDiagnostics();
    const { observations, metrics } = this.state;
    let nativeHandleCount = 0;
    let nativeTrackedFileCount = 0;
    let pendingEventCount = 0;
    let pendingReconciliationWorkCount = 0;
    let reconciliationInFlightCount = 0;
    for (const observation of observations) {
      const diagnostics = observation.getDiagnostics();
      nativeHandleCount += diagnostics.nativeHandleCount;
      nativeTrackedFileCount += diagnostics.nativeTrackedFileCount;
      pendingEventCount += diagnostics.pendingEventCount;
      pendingReconciliationWorkCount += diagnostics.pendingReconciliationWorkCount;
      reconciliationInFlightCount += Number(diagnostics.reconciliationInFlight);
    }
    return {
      activeObservationCount: observations.size,
      nativeHandleCount,
      nativeTrackedFileCount,
      pendingEventCount,
      pendingReconciliationWorkCount,
      reconciliationInFlightCount,
      ...metrics,
    };
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.state.status === "closed") return Promise.resolve();
    const observations = [...this.state.observations];
    this.state = { status: "closed" };
    this.closePromise = Promise.allSettled(
      observations.map((observation) => observation.close()),
    ).then(() => undefined);
    return this.closePromise;
  }
}

function createObserverMetrics(): ObserverMetrics {
  return {
    reconciliationCount: 0,
    scopedReconciliationCount: 0,
    fullReconciliationCount: 0,
    reconciliationFailureCount: 0,
    observerFailureCount: 0,
    directoryLimitFailureCount: 0,
    nativeEventCount: 0,
    nativeChangeEventCount: 0,
    nativeRenameEventCount: 0,
    nativePathlessEventCount: 0,
    nativeClassificationCount: 0,
    nativeShallowScanCount: 0,
    lastReconciliationDurationMs: 0,
    maxReconciliationDurationMs: 0,
  };
}

function emptyDiagnostics(): FileObserverDiagnostics {
  return {
    activeObservationCount: 0,
    nativeHandleCount: 0,
    nativeTrackedFileCount: 0,
    pendingEventCount: 0,
    pendingReconciliationWorkCount: 0,
    reconciliationInFlightCount: 0,
    ...createObserverMetrics(),
  };
}

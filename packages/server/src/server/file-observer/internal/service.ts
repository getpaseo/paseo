import { resolve } from "node:path";
import type {
  FileObserver,
  FileObserverCallback,
  FileObserverDiagnostics,
  FileObserverOptions,
  FileObserverSubscription,
} from "../index.js";
import type { CreateObservationBackend, ObserverMetrics } from "./contracts.js";
import { createManagedObservation, type ManagedObservation } from "./observation.js";
import type { ObserverPaths } from "./paths.js";

export class FileObserverService implements FileObserver {
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
    private readonly paths: ObserverPaths,
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
    const { signal } = options;
    signal?.throwIfAborted();
    state.observations.add(observation);
    const abort = () => void observation.close();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await observation.start();
    } finally {
      signal?.removeEventListener("abort", abort);
    }
    if (signal?.aborted) {
      await observation.close();
      throw signal.reason;
    }
    if (this.closePromise) {
      await observation.close();
      throw new Error("File observer is closed");
    }
    return observation.subscription();
  }

  getDiagnostics(): FileObserverDiagnostics {
    if (this.state.status === "closed") return emptyDiagnostics();
    const { observations, metrics } = this.state;
    let nativeHandleCount = 0;
    let nativeTrackedFileCount = 0;
    let pendingEventCount = 0;
    let pendingReconciliationWorkCount = 0;
    let pendingClassificationCount = 0;
    let reconciliationInFlightCount = 0;
    for (const observation of observations) {
      const diagnostics = observation.getDiagnostics();
      nativeHandleCount += diagnostics.nativeHandleCount;
      nativeTrackedFileCount += diagnostics.nativeTrackedFileCount;
      pendingEventCount += diagnostics.pendingEventCount;
      pendingReconciliationWorkCount += diagnostics.pendingReconciliationWorkCount;
      pendingClassificationCount += diagnostics.pendingClassificationCount;
      reconciliationInFlightCount += Number(diagnostics.reconciliationInFlight);
    }
    return {
      activeObservationCount: observations.size,
      nativeHandleCount,
      nativeTrackedFileCount,
      pendingEventCount,
      pendingReconciliationWorkCount,
      pendingClassificationCount,
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
    pendingClassificationCount: 0,
    reconciliationInFlightCount: 0,
    ...createObserverMetrics(),
  };
}

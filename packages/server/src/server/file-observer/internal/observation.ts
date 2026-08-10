import { stat } from "node:fs/promises";
import type {
  FileChange,
  FileChangeType,
  FileObserverCallback,
  FileObserverOptions,
  FileObserverSubscription,
} from "../index.js";
import type {
  BackendDiagnostics,
  CreateObservationBackend,
  ObservationBackend,
  ObservationHost,
  ObserverMetrics,
} from "./contracts.js";
import type { ObserverPaths } from "./paths.js";
import { toError } from "./paths.js";

const EVENT_BATCH_DELAY_MS = 10;

export interface ManagedObservation {
  start(): Promise<void>;
  subscription(): FileObserverSubscription;
  close(): Promise<void>;
  getDiagnostics(): BackendDiagnostics & { pendingEventCount: number };
}

export function createManagedObservation(input: {
  root: string;
  callback: FileObserverCallback;
  options: FileObserverOptions;
  paths: ObserverPaths;
  metrics: ObserverMetrics;
  createBackend: CreateObservationBackend;
  onClosed: () => void;
}): ManagedObservation {
  return new Observation(input);
}

class Observation implements ManagedObservation, ObservationHost {
  readonly root: string;
  readonly metrics: ObserverMetrics;
  private ignoredRoots: string[];
  private status: "open" | "failed" | "closed" = "open";
  private readonly backend: ObservationBackend;
  private readonly pendingEvents = new Map<string, FileChange>();
  private flushTimer: NodeJS.Timeout | null = null;
  private closePromise: Promise<void> | null = null;

  constructor(
    private readonly input: {
      root: string;
      callback: FileObserverCallback;
      options: FileObserverOptions;
      paths: ObserverPaths;
      metrics: ObserverMetrics;
      createBackend: CreateObservationBackend;
      onClosed: () => void;
    },
  ) {
    this.root = input.root;
    this.metrics = input.metrics;
    this.ignoredRoots = input.paths.normalizeIgnoredRoots(input.root, input.options.ignore ?? []);
    this.backend = input.createBackend(this);
  }

  async start(): Promise<void> {
    const rootStats = await stat(this.root);
    if (!rootStats.isDirectory()) {
      throw new Error(`File observation requires a directory: ${this.root}`);
    }
    try {
      await this.backend.start();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  subscription(): FileObserverSubscription {
    return {
      updateIgnore: (paths) => this.updateIgnore(paths),
      unsubscribe: () => this.close(),
    };
  }

  async updateIgnore(paths: string[]): Promise<void> {
    if (!this.isActive()) return;
    const next = this.input.paths.normalizeIgnoredRoots(this.root, paths);
    if (samePaths(this.ignoredRoots, next)) return;
    this.ignoredRoots = next;
    for (const path of this.pendingEvents.keys()) {
      if (this.isIgnored(path)) this.pendingEvents.delete(path);
    }
    try {
      await this.backend.updateIgnore();
    } catch (error) {
      this.fail(toError(error));
      throw error;
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.status = "closed";
    this.cancelDelivery();
    this.closePromise = this.backend.close().finally(this.input.onClosed);
    return this.closePromise;
  }

  getDiagnostics(): BackendDiagnostics & { pendingEventCount: number } {
    return {
      ...this.backend.getDiagnostics(),
      pendingEventCount: this.pendingEvents.size,
    };
  }

  isActive(): boolean {
    return this.status === "open";
  }

  isIgnored(path: string): boolean {
    return this.ignoredRoots.some((root) => this.input.paths.isInside(root, path));
  }

  isPathInside(root: string, path: string): boolean {
    return this.input.paths.isInside(root, path);
  }

  queueEvent(type: FileChangeType, path: string): void {
    if (!this.isActive() || this.isIgnored(path)) return;
    const previous = this.pendingEvents.get(path);
    this.pendingEvents.set(path, mergeChange(previous, { path, type }));
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (!this.isActive() || this.pendingEvents.size === 0) return;
      const events = [...this.pendingEvents.values()];
      this.pendingEvents.clear();
      this.input.callback(null, events);
    }, EVENT_BATCH_DELAY_MS);
  }

  fail(error: Error): void {
    if (!this.isActive()) return;
    this.status = "failed";
    this.metrics.observerFailureCount += 1;
    this.cancelDelivery();
    this.beginFailureClose();
    this.input.callback(error, []);
  }

  private beginFailureClose(): void {
    this.closePromise = this.backend.close().finally(this.input.onClosed);
  }

  private cancelDelivery(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.pendingEvents.clear();
  }
}

function samePaths(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

function mergeChange(previous: FileChange | undefined, next: FileChange): FileChange {
  if (!previous) return next;
  if (previous.type === "create" && next.type === "delete") return { ...next, type: "update" };
  if (previous.type === "delete" && next.type === "create") return { ...next, type: "update" };
  if (previous.type === "create") return previous;
  return next;
}

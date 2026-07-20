import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import type { FileVersion } from "@getpaseo/protocol/messages";
import { getExplorerFileVersion, resolveExplorerFilePath } from "./service.js";

interface FileWatch {
  close(): void;
}

export interface FileObserverDependencies {
  watchDirectory(
    directory: string,
    onChange: (filename: string | null) => void,
    onError: () => void,
  ): FileWatch;
  setTimeout(callback: () => void | Promise<void>, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
  setInterval(
    callback: () => void | Promise<void>,
    delayMs: number,
  ): ReturnType<typeof setInterval>;
  clearInterval(handle: ReturnType<typeof setInterval>): void;
}

interface ObservedFile {
  cwd: string;
  path: string;
  basename: string;
  listeners: Map<(version: FileVersion) => void, { cwd: string; path: string }>;
  fingerprint: string;
  watcher: FileWatch | null;
  debounce: ReturnType<typeof setTimeout> | null;
  fallback: ReturnType<typeof setInterval> | null;
}

const nodeDependencies: FileObserverDependencies = {
  watchDirectory(directory, onChange, onError) {
    const watcher: FSWatcher = watch(directory, (_event, filename) => {
      onChange(filename === null ? null : filename.toString());
    });
    watcher.on("error", onError);
    return watcher;
  },
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
};

export class FileObserver {
  private readonly dependencies: FileObserverDependencies;
  private readonly observed = new Map<string, ObservedFile>();

  constructor(dependencies: FileObserverDependencies = nodeDependencies) {
    this.dependencies = dependencies;
  }

  async subscribe(
    input: { cwd: string; path: string },
    listener: (version: FileVersion) => void,
  ): Promise<{ initial: FileVersion; unsubscribe: () => void }> {
    const target = await resolveExplorerFilePath({ root: input.cwd, relativePath: input.path });
    let observed = this.observed.get(target);
    if (!observed) {
      const initial = await getExplorerFileVersion({ root: input.cwd, relativePath: input.path });
      observed = this.observed.get(target);
      if (!observed) {
        observed = {
          cwd: input.cwd,
          path: input.path,
          basename: path.basename(target),
          listeners: new Map(),
          fingerprint: fingerprint(initial),
          watcher: null,
          debounce: null,
          fallback: null,
        };
        this.observed.set(target, observed);
        this.startWatching(target, path.dirname(target), observed);
      }
    }
    const initial = await getExplorerFileVersion({
      root: input.cwd,
      relativePath: input.path,
    });
    observed.listeners.set(listener, { cwd: initial.cwd, path: initial.path });
    observed.fingerprint = fingerprint(initial);

    let active = true;
    return {
      initial,
      unsubscribe: () => {
        if (!active) return;
        active = false;
        observed?.listeners.delete(listener);
        if (observed && observed.listeners.size === 0) {
          this.stopWatching(observed);
          this.observed.delete(target);
        }
      },
    };
  }

  dispose(): void {
    for (const observed of this.observed.values()) {
      this.stopWatching(observed);
    }
    this.observed.clear();
  }

  private startWatching(target: string, directory: string, observed: ObservedFile): void {
    try {
      observed.watcher = this.dependencies.watchDirectory(
        directory,
        (filename) => {
          if (filename === null || filename === observed.basename) {
            this.scheduleRestat(target, observed);
          }
        },
        () => this.useFallback(target, observed),
      );
    } catch {
      this.useFallback(target, observed);
    }
  }

  private useFallback(target: string, observed: ObservedFile): void {
    observed.watcher?.close();
    observed.watcher = null;
    if (observed.fallback) return;
    observed.fallback = this.dependencies.setInterval(() => this.restate(target, observed), 5_000);
  }

  private scheduleRestat(target: string, observed: ObservedFile): void {
    if (observed.debounce) {
      this.dependencies.clearTimeout(observed.debounce);
    }
    observed.debounce = this.dependencies.setTimeout(() => {
      observed.debounce = null;
      return this.restate(target, observed);
    }, 50);
  }

  private async restate(target: string, observed: ObservedFile): Promise<void> {
    if (this.observed.get(target) !== observed) return;
    const version = await getExplorerFileVersion({
      root: observed.cwd,
      relativePath: observed.path,
    });
    const nextFingerprint = fingerprint(version);
    if (nextFingerprint === observed.fingerprint) return;
    observed.fingerprint = nextFingerprint;
    for (const [listener, identity] of observed.listeners) {
      listener({ ...version, ...identity });
    }
  }

  private stopWatching(observed: ObservedFile): void {
    observed.watcher?.close();
    if (observed.debounce) this.dependencies.clearTimeout(observed.debounce);
    if (observed.fallback) this.dependencies.clearInterval(observed.fallback);
    observed.watcher = null;
    observed.debounce = null;
    observed.fallback = null;
  }
}

function fingerprint(version: FileVersion): string {
  if (version.status !== "ready") return version.status;
  return `${version.status}:${version.revision ?? `${version.size}:${version.modifiedAt}`}`;
}

export const workspaceFileObserver = new FileObserver();

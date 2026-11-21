import {
  PluginFileConflictError,
  PluginFileDeletedError,
  type PluginFile,
  type PluginFileEvent,
  type PluginFileWriteOptions,
} from "@getpaseo/plugin/client";
import type { FileVersion, FileWriteResult } from "@getpaseo/protocol/messages";
import { decodeUtf8 } from "@/utils/decode-utf8";

export interface FileTarget {
  cwd: string;
  path: string;
}

export type FileKind = "text" | "image" | "binary";

/** A version the session has classified, so a panel can be chosen before the file is read. */
export interface FileStat {
  status: "ready";
  size: number;
  modifiedAt: string;
  revision?: string;
  kind: FileKind;
  mimeType: string;
}

export type FileObservation =
  | FileStat
  | Extract<FileVersion, { status: "missing" }>
  | Extract<FileVersion, { status: "error" }>;

export interface FileContents {
  bytes: Uint8Array;
  size: number;
  modifiedAt: string;
  revision?: string;
}

/** What a handle needs from the host. The daemon implementation lives in `./daemon-session`. */
export interface FileSession {
  observe(
    target: FileTarget,
    onObservation: (observation: FileObservation) => void,
  ): Promise<{ initial: FileObservation; unsubscribe(): void }>;
  read(target: FileTarget): Promise<FileContents>;
  write(input: {
    target: FileTarget;
    content: string | Uint8Array;
    expectedModifiedAt: string;
    expectedRevision?: string;
  }): Promise<FileWriteResult>;
  createUrl(input: { target: FileTarget; bytes: Uint8Array; mimeType: string }): Promise<{
    url: string;
    release(): void;
  }>;
}

export type FileHandleSnapshot =
  | { status: "loading" }
  | FileStat
  | { status: "missing" }
  | { status: "error"; error: string };

interface Version {
  size: number;
  modifiedAt: string;
  revision?: string;
}

/**
 * One file tab target's file: its stat for choosing a panel, and the `PluginFile` every panel
 * reads and writes through.
 *
 * The handle remembers the version it last read or wrote, and writes only over that version.
 * Changes on disk reach `watch` listeners once per version; versions this handle read or wrote
 * itself do not. Reads wait for this handle's writes, so a panel that mounts while another flushes
 * reads the flushed file. Writes run one at a time, and wait while the tab holds them.
 *
 * Once the file has a stat, the snapshot keeps it: the mounted panel keeps what it shows, and
 * learns about a deletion from `watch`. A deletion is reported only after a read confirms it, so a
 * program that removes the file and writes it back does not look like one.
 */
export class FileHandle {
  readonly file: PluginFile;
  private readonly listeners = new Set<() => void>();
  private readonly watchers = new Set<(event: PluginFileEvent) => void>();
  private snapshot: FileHandleSnapshot = { status: "loading" };
  private stat: FileStat | null = null;
  private latest: FileObservation | null = null;
  private base: Version | null = null;
  /** Versions this handle has read, written, or told watchers about. */
  private readonly seen = new Set<string>();
  private deleted = false;
  private confirmingDeletion = false;
  private hasBom = false;
  private writes: Promise<unknown> = Promise.resolve();
  private writing = 0;
  private holds = 0;
  private releaseHold: (() => void) | null = null;
  private held: Promise<void> | null = null;
  private observing: { generation: number; unsubscribe: (() => void) | null } | null = null;
  private generation = 0;
  private currentUrl: { key: string; url: Promise<string>; release: () => void } | null = null;
  private disposed = false;

  constructor(
    private readonly session: FileSession,
    private readonly target: FileTarget,
    absolutePath: string,
  ) {
    const stat = () => this.stat;
    const name = absolutePath.split(/[\\/]/).pop() ?? "";
    const dot = name.lastIndexOf(".");
    this.file = {
      path: absolutePath,
      name,
      extension: dot < 0 ? "" : name.slice(dot + 1).toLowerCase(),
      get size() {
        return stat()?.size ?? 0;
      },
      get modifiedAt() {
        return stat()?.modifiedAt ?? "";
      },
      get mimeType() {
        return stat()?.mimeType ?? "application/octet-stream";
      },
      readText: () => this.readText(),
      readBytes: () => this.readBytes(),
      url: () => this.url(),
      writeText: (text, options) => this.writeText(text, options),
      writeBytes: (bytes, options) => this.write(bytes, options),
      watch: (listener) => {
        this.watchers.add(listener);
        return () => this.watchers.delete(listener);
      },
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): FileHandleSnapshot => this.snapshot;

  /** Observes the file while the tab is on screen. Coming back reports what changed meanwhile. */
  setObserving(observing: boolean): void {
    if (this.disposed || observing === (this.observing !== null)) return;
    if (!observing) {
      this.stopObserving();
      return;
    }
    const generation = ++this.generation;
    this.observing = { generation, unsubscribe: null };
    void this.observe(generation);
  }

  private async observe(generation: number): Promise<void> {
    let subscription: Awaited<ReturnType<FileSession["observe"]>>;
    try {
      subscription = await this.session.observe(this.target, (observation) => {
        if (this.observing?.generation === generation) this.receive(observation);
      });
    } catch (error) {
      if (this.observing?.generation !== generation) return;
      this.observing = null;
      this.setSnapshot({ status: "error", error: errorMessage(error) });
      return;
    }
    if (this.observing?.generation !== generation) {
      subscription.unsubscribe();
      return;
    }
    this.observing.unsubscribe = subscription.unsubscribe;
    this.receive(subscription.initial);
  }

  /** Observes again after a failure. */
  retry = (): void => {
    this.stopObserving();
    this.setObserving(true);
  };

  /**
   * Holds this file's writes while the tab asks whether to discard unsaved changes. The returned
   * function lets them run; closing the tab disposes the handle, which drops them.
   */
  holdWrites = (): (() => void) => {
    this.holds += 1;
    if (this.holds === 1) {
      this.held = new Promise((resolve) => {
        this.releaseHold = resolve;
      });
    }
    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true;
      this.holds -= 1;
      if (this.holds > 0) return;
      this.releaseHold?.();
      this.releaseHold = null;
      this.held = null;
    };
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopObserving();
    this.currentUrl?.release();
    this.currentUrl = null;
    this.releaseHold?.();
    this.listeners.clear();
    this.watchers.clear();
  }

  private stopObserving(): void {
    this.observing?.unsubscribe?.();
    this.observing = null;
  }

  private receive(observation: FileObservation): void {
    if (this.disposed) return;
    this.latest = observation;
    if (observation.status === "ready") {
      this.stat = observation;
      if (!this.base) this.adopt(observation);
      this.setSnapshot(observation);
    } else if (!this.stat) {
      this.setSnapshot(
        observation.status === "missing"
          ? { status: "missing" }
          : { status: "error", error: observation.error },
      );
    }
    this.notifyChange(observation);
  }

  /** Tells watchers about a disk version this handle did not read or write itself. */
  private notifyChange(observation: FileObservation): void {
    if (this.writing > 0 || observation.status === "error") return;
    if (observation.status === "missing") {
      if (!this.deleted) void this.confirmDeletion();
      return;
    }
    this.notifyVersion(observation);
  }

  private notifyVersion(version: Version): void {
    const key = versionKey(version);
    const restored = this.deleted;
    this.deleted = false;
    if (this.seen.has(key) && !restored) return;
    this.seen.add(key);
    this.emit({ type: "changed" });
  }

  private async confirmDeletion(): Promise<void> {
    if (this.confirmingDeletion) return;
    this.confirmingDeletion = true;
    let contents: FileContents | null = null;
    try {
      contents = await this.session.read(this.target);
    } catch {
      // The read failing is the confirmation.
    } finally {
      this.confirmingDeletion = false;
    }
    if (this.disposed || this.writing > 0 || this.deleted) return;
    if (contents) {
      this.notifyVersion(contents);
      return;
    }
    if (this.latest?.status !== "missing") return;
    this.deleted = true;
    this.emit({ type: "deleted" });
  }

  private emit(event: PluginFileEvent): void {
    for (const watcher of this.watchers) watcher(event);
  }

  private async readContents(): Promise<FileContents> {
    this.assertOpen();
    await this.writes;
    const contents = await this.session.read(this.target);
    this.assertOpen();
    this.adopt(contents);
    return contents;
  }

  private async readText(): Promise<string> {
    const { bytes } = await this.readContents();
    this.hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    return decodeUtf8(bytes);
  }

  private async readBytes(): Promise<Uint8Array> {
    return (await this.readContents()).bytes;
  }

  private url(): Promise<string> {
    const current = this.currentUrl;
    if (current && this.stat && current.key === versionKey(this.stat)) return current.url;
    return this.createUrl();
  }

  private async createUrl(): Promise<string> {
    const contents = await this.readContents();
    const key = versionKey(contents);
    if (this.currentUrl?.key === key) return this.currentUrl.url;
    const created = await this.session.createUrl({
      target: this.target,
      bytes: contents.bytes,
      mimeType: this.file.mimeType,
    });
    if (this.disposed) {
      created.release();
      throw new Error("The file tab was closed.");
    }
    this.currentUrl?.release();
    this.currentUrl = { key, url: Promise.resolve(created.url), release: created.release };
    return created.url;
  }

  private writeText(text: string, options?: PluginFileWriteOptions): Promise<void> {
    return this.write(this.hasBom ? `﻿${text}` : text, options);
  }

  private write(content: string | Uint8Array, options?: PluginFileWriteOptions): Promise<void> {
    const write = this.writes.then(() => this.performWrite(content, options?.force === true));
    this.writes = write.catch(() => undefined);
    return write;
  }

  private async performWrite(content: string | Uint8Array, force: boolean): Promise<void> {
    this.assertOpen();
    if (this.held) await this.held;
    this.assertOpen();
    this.writing += 1;
    try {
      let expected = force ? (this.stat ?? this.base) : this.base;
      for (let attempt = 0; ; attempt += 1) {
        if (!expected) throw new PluginFileConflictError();
        const result = await this.session.write({
          target: this.target,
          content,
          expectedModifiedAt: expected.modifiedAt,
          expectedRevision: expected.revision,
        });
        if (result.status === "written") {
          this.adopt(result);
          return;
        }
        if (result.status === "error") throw new Error(result.error);
        const disk = result.version;
        if (force && attempt === 0 && disk.status === "ready") {
          expected = disk;
          continue;
        }
        if (disk.status === "missing") throw new PluginFileDeletedError();
        throw new PluginFileConflictError();
      }
    } finally {
      this.writing -= 1;
      // Observations that arrived during the write may be its own version, so they wait for it.
      if (this.latest && !this.disposed) this.notifyChange(this.latest);
    }
  }

  /** Records a version this handle read or wrote, so its observation does not notify. */
  private adopt(version: Version): void {
    this.base = { size: version.size, modifiedAt: version.modifiedAt, revision: version.revision };
    this.seen.add(versionKey(version));
    if (this.stat && versionKey(this.stat) !== versionKey(version)) {
      this.stat = { ...this.stat, ...this.base };
      this.setSnapshot(this.stat);
    }
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error("The file tab was closed.");
  }

  private setSnapshot(snapshot: FileHandleSnapshot): void {
    if (sameSnapshot(this.snapshot, snapshot)) return;
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

function versionKey(version: Version): string {
  return version.revision ?? `${version.size}:${version.modifiedAt}`;
}

function sameSnapshot(current: FileHandleSnapshot, next: FileHandleSnapshot): boolean {
  if (current.status !== next.status) return false;
  if (current.status === "ready" && next.status === "ready") {
    return (
      versionKey(current) === versionKey(next) &&
      current.kind === next.kind &&
      current.mimeType === next.mimeType
    );
  }
  if (current.status === "error" && next.status === "error") return current.error === next.error;
  return true;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

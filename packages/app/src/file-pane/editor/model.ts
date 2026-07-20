import type { FileVersion, FileWriteResult } from "@getpaseo/protocol/messages";

export type FileEditorStatus = "loading" | "clean" | "dirty" | "saving" | "conflict" | "error";

export interface FileEditorSnapshot {
  status: FileEditorStatus;
  content: string;
  modified: boolean;
  version: FileVersion;
  observedVersion: FileVersion;
  error: string | null;
}

export interface FileEditorFile {
  content: string;
  version: Extract<FileVersion, { status: "ready" }>;
}

export interface FileEditorSession {
  read(): Promise<FileEditorFile>;
  write(input: { content: string; expectedModifiedAt: string }): Promise<FileWriteResult>;
}

export interface FileEditorClock {
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

const systemClock: FileEditorClock = {
  setTimeout(callback, delay) {
    return globalThis.setTimeout(callback, delay);
  },
  clearTimeout(handle) {
    globalThis.clearTimeout(handle);
  },
};

export class FileEditorModel {
  private readonly session: FileEditorSession;
  private readonly clock: FileEditorClock;
  private readonly listeners = new Set<() => void>();
  private snapshot: FileEditorSnapshot;
  private autosave: ReturnType<typeof setTimeout> | null = null;
  private saveSequence = 0;
  private disposed = false;
  private observedWhileSaving: FileVersion | null = null;
  private persistedContent: string;

  constructor(input: {
    file: FileEditorFile;
    session: FileEditorSession;
    clock?: FileEditorClock;
  }) {
    this.session = input.session;
    this.clock = input.clock ?? systemClock;
    this.persistedContent = input.file.content;
    this.snapshot = {
      status: "clean",
      content: input.file.content,
      modified: false,
      version: input.file.version,
      observedVersion: input.file.version,
      error: null,
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): FileEditorSnapshot => this.snapshot;

  edit(content: string): void {
    if (this.disposed || content === this.snapshot.content) return;
    const modified = content !== this.persistedContent;
    let status: FileEditorStatus = modified ? "dirty" : "clean";
    if (this.snapshot.status === "conflict") status = "conflict";
    this.setSnapshot({ ...this.snapshot, status, content, modified, error: null });
    if (status === "dirty") this.scheduleAutosave();
    else this.clearAutosave();
  }

  async save(): Promise<void> {
    if (this.disposed || (this.snapshot.status !== "dirty" && this.snapshot.status !== "error")) {
      return;
    }
    if (this.snapshot.observedVersion.status !== "ready") {
      this.enterConflict(this.snapshot.observedVersion);
      return;
    }
    await this.performWrite(this.snapshot.observedVersion.modifiedAt);
  }

  receiveFileVersion(version: FileVersion): void {
    if (this.disposed || sameVersion(version, this.snapshot.observedVersion)) return;
    this.setSnapshot({ ...this.snapshot, observedVersion: version });
    if (this.snapshot.status === "saving") {
      this.observedWhileSaving = version;
      return;
    }
    if (this.snapshot.status === "clean") {
      void this.reloadFromDisk(version);
      return;
    }
    this.enterConflict(version);
  }

  async overwrite(): Promise<void> {
    if (this.disposed || this.snapshot.status !== "conflict") return;
    if (this.snapshot.observedVersion.status !== "ready") return;
    await this.performWrite(this.snapshot.observedVersion.modifiedAt);
  }

  async reload(): Promise<void> {
    if (this.disposed) return;
    await this.reloadFromDisk(this.snapshot.observedVersion);
  }

  dispose(): void {
    this.disposed = true;
    this.saveSequence += 1;
    this.clearAutosave();
    this.listeners.clear();
  }

  private async performWrite(expectedModifiedAt: string): Promise<void> {
    this.clearAutosave();
    const sequence = ++this.saveSequence;
    const content = this.snapshot.content;
    this.observedWhileSaving = null;
    this.setSnapshot({ ...this.snapshot, status: "saving", error: null });
    let result: FileWriteResult;
    try {
      result = await this.session.write({ content, expectedModifiedAt });
    } catch (error) {
      if (this.disposed || sequence !== this.saveSequence) return;
      this.setSnapshot({
        ...this.snapshot,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (this.disposed || sequence !== this.saveSequence) return;
    if (result.status === "error") {
      this.setSnapshot({ ...this.snapshot, status: "error", error: result.error });
      return;
    }
    if (result.status === "conflict") {
      this.enterConflict(result.version);
      return;
    }

    const writtenVersion: FileVersion = {
      status: "ready",
      cwd: this.snapshot.version.cwd,
      path: this.snapshot.version.path,
      size: result.size,
      modifiedAt: result.modifiedAt,
    };
    const pending = this.observedWhileSaving;
    this.observedWhileSaving = null;
    this.persistedContent = content;
    if (pending && !sameVersion(pending, writtenVersion)) {
      this.setSnapshot({
        ...this.snapshot,
        status: "conflict",
        modified: this.snapshot.content !== this.persistedContent,
        version: writtenVersion,
        observedVersion: pending,
        error: null,
      });
      return;
    }
    const modified = this.snapshot.content !== this.persistedContent;
    this.setSnapshot({
      ...this.snapshot,
      status: modified ? "dirty" : "clean",
      modified,
      version: writtenVersion,
      observedVersion: writtenVersion,
      error: null,
    });
    if (modified) this.scheduleAutosave();
  }

  private async reloadFromDisk(version: FileVersion): Promise<void> {
    this.clearAutosave();
    if (version.status !== "ready") {
      this.enterConflict(version);
      return;
    }
    const sequence = ++this.saveSequence;
    this.setSnapshot({ ...this.snapshot, status: "loading", error: null });
    try {
      const file = await this.session.read();
      if (this.disposed || sequence !== this.saveSequence) return;
      this.persistedContent = file.content;
      this.setSnapshot({
        status: "clean",
        content: file.content,
        modified: false,
        version: file.version,
        observedVersion: file.version,
        error: null,
      });
    } catch (error) {
      if (this.disposed || sequence !== this.saveSequence) return;
      this.setSnapshot({
        ...this.snapshot,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private enterConflict(version: FileVersion): void {
    this.clearAutosave();
    this.setSnapshot({
      ...this.snapshot,
      status: "conflict",
      modified: this.snapshot.content !== this.persistedContent,
      observedVersion: version,
      error: version.status === "error" ? version.error : null,
    });
  }

  private scheduleAutosave(): void {
    this.clearAutosave();
    this.autosave = this.clock.setTimeout(() => {
      this.autosave = null;
      void this.save();
    }, 800);
  }

  private clearAutosave(): void {
    if (!this.autosave) return;
    this.clock.clearTimeout(this.autosave);
    this.autosave = null;
  }

  private setSnapshot(snapshot: FileEditorSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

function sameVersion(left: FileVersion, right: FileVersion): boolean {
  if (left.status !== right.status || left.cwd !== right.cwd || left.path !== right.path)
    return false;
  if (left.status === "ready" && right.status === "ready") {
    return left.modifiedAt === right.modifiedAt && left.size === right.size;
  }
  if (left.status === "error" && right.status === "error") return left.error === right.error;
  return true;
}

import {
  PluginFileConflictError,
  PluginFileDeletedError,
  type PluginFile,
  type PluginFileEvent,
} from "@getpaseo/plugin/client";

export type FileEditorStatus =
  | "loading"
  | "failed"
  | "clean"
  | "dirty"
  | "saving"
  | "conflict"
  | "error";
export type FileLineSeparator = "\n" | "\r\n" | "\r";

export interface FileEditorSnapshot {
  status: FileEditorStatus;
  content: string;
  lineSeparator: FileLineSeparator;
  /** The buffer differs from what this editor last read or saved. */
  modified: boolean;
  /** Why the editor is in conflict: the file changed or was deleted on disk. */
  conflict: "changed" | "deleted" | null;
  /** The failed load's or save's message. */
  error: string | null;
}

export type FileConflictCallout = { kind: "changed"; canOverwrite: boolean } | { kind: "deleted" };

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

const AUTOSAVE_DELAY_MS = 800;

/**
 * Source's buffer over a `PluginFile`: reads the file, autosaves edits, and reconciles changes on
 * disk. A clean buffer follows the disk; a modified one conflicts and the user overwrites or
 * reloads. The file handle rejects writes over versions this editor has not read.
 */
export class FileEditorModel {
  private readonly file: PluginFile;
  private readonly clock: FileEditorClock;
  private readonly listeners = new Set<() => void>();
  private snapshot: FileEditorSnapshot = {
    status: "loading",
    content: "",
    lineSeparator: "\n",
    modified: false,
    conflict: null,
    error: null,
  };
  private persisted = "";
  private autosave: ReturnType<typeof setTimeout> | null = null;
  private saving = false;
  private saveSequence = 0;
  private readSequence = 0;
  private eventDuringSave: PluginFileEvent | null = null;
  private unwatch: (() => void) | null = null;
  private disposed = false;

  constructor(input: { file: PluginFile; clock?: FileEditorClock }) {
    this.file = input.file;
    this.clock = input.clock ?? systemClock;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): FileEditorSnapshot => this.snapshot;

  /** Reads the file and follows its changes on disk. */
  open(): void {
    if (this.disposed || this.unwatch) return;
    this.unwatch = this.file.watch((event) => this.receiveFileEvent(event));
    void this.reload();
  }

  edit(content: string): void {
    if (this.disposed || !this.isLoaded() || content === this.snapshot.content) return;
    const modified = content !== this.persisted;
    let status: FileEditorStatus = modified ? "dirty" : "clean";
    if (this.snapshot.status === "conflict") status = "conflict";
    this.setSnapshot({ ...this.snapshot, status, content, modified, error: null });
    if (status === "dirty") this.scheduleAutosave();
    else this.clearAutosave();
  }

  async save(): Promise<void> {
    if (this.snapshot.status !== "dirty" && this.snapshot.status !== "error") return;
    await this.write({ force: false });
  }

  /** Writes the buffer over a file that changed on disk. */
  async overwrite(): Promise<void> {
    if (this.snapshot.conflict !== "changed") return;
    await this.write({ force: true });
  }

  /** Replaces the buffer with the file on disk. */
  async reload(): Promise<void> {
    if (this.disposed) return;
    const sequence = ++this.readSequence;
    try {
      const content = await this.file.readText();
      if (this.disposed || sequence !== this.readSequence) return;
      this.applyFile(content);
    } catch (error) {
      if (this.disposed || sequence !== this.readSequence) return;
      if (this.isLoaded()) return;
      this.setSnapshot({ ...this.snapshot, status: "failed", error: errorMessage(error) });
    }
  }

  /**
   * Stops following the file. With `flush`, a modified buffer is written first, so switching to
   * another panel keeps the edit. The tab holds that write while it asks to discard it.
   */
  dispose({ flush }: { flush: boolean }): void {
    if (this.disposed) return;
    const status = this.snapshot.status;
    if (flush && this.snapshot.modified && status !== "conflict") {
      void this.file.writeText(this.snapshot.content).catch(() => undefined);
    }
    this.disposed = true;
    this.clearAutosave();
    this.unwatch?.();
    this.unwatch = null;
    this.listeners.clear();
  }

  private receiveFileEvent(event: PluginFileEvent): void {
    if (this.disposed) return;
    if (!this.isLoaded()) {
      if (event.type === "changed") void this.reload();
      return;
    }
    if (this.saving) {
      this.eventDuringSave = event;
      return;
    }
    if (event.type === "deleted") {
      this.enterConflict("deleted");
      return;
    }
    void this.reconcile();
  }

  /** Follows a clean buffer to the disk; a modified one conflicts unless the disk matches it. */
  private async reconcile(): Promise<void> {
    const sequence = ++this.readSequence;
    let content: string;
    try {
      content = await this.file.readText();
    } catch {
      return;
    }
    if (this.disposed || sequence !== this.readSequence) return;
    if (this.saving) {
      this.eventDuringSave = { type: "changed" };
      return;
    }
    if (content === this.persisted) {
      this.adoptUnchangedFile();
      return;
    }
    if (!this.snapshot.modified) {
      this.applyFile(content);
      return;
    }
    this.enterConflict("changed");
  }

  private async write({ force }: { force: boolean }): Promise<void> {
    if (this.disposed) return;
    this.clearAutosave();
    const sequence = ++this.saveSequence;
    const content = this.snapshot.content;
    this.saving = true;
    this.eventDuringSave = null;
    this.setSnapshot({ ...this.snapshot, status: "saving", conflict: null, error: null });
    try {
      await this.file.writeText(content, { force });
    } catch (error) {
      this.saving = false;
      if (this.disposed || sequence !== this.saveSequence) return;
      if (error instanceof PluginFileConflictError) this.enterConflict("changed");
      else if (error instanceof PluginFileDeletedError) this.enterConflict("deleted");
      else this.setSnapshot({ ...this.snapshot, status: "error", error: errorMessage(error) });
      this.receivePendingEvent();
      return;
    }
    this.saving = false;
    if (this.disposed || sequence !== this.saveSequence) return;
    this.persisted = content;
    const modified = this.snapshot.content !== this.persisted;
    this.setSnapshot({ ...this.snapshot, status: modified ? "dirty" : "clean", modified });
    if (modified) this.scheduleAutosave();
    this.receivePendingEvent();
  }

  private receivePendingEvent(): void {
    const event = this.eventDuringSave;
    this.eventDuringSave = null;
    if (event) this.receiveFileEvent(event);
  }

  private applyFile(content: string): void {
    this.clearAutosave();
    this.saveSequence += 1;
    this.persisted = content;
    this.setSnapshot({
      status: "clean",
      content,
      lineSeparator: detectLineSeparator(content),
      modified: false,
      conflict: null,
      error: null,
    });
  }

  private adoptUnchangedFile(): void {
    if (this.snapshot.status !== "conflict") return;
    const status = this.snapshot.modified ? "dirty" : "clean";
    this.setSnapshot({ ...this.snapshot, status, conflict: null, error: null });
    if (status === "dirty") this.scheduleAutosave();
  }

  private enterConflict(conflict: "changed" | "deleted"): void {
    this.clearAutosave();
    this.setSnapshot({ ...this.snapshot, status: "conflict", conflict, error: null });
  }

  private isLoaded(): boolean {
    return this.snapshot.status !== "loading" && this.snapshot.status !== "failed";
  }

  private scheduleAutosave(): void {
    this.clearAutosave();
    this.autosave = this.clock.setTimeout(() => {
      this.autosave = null;
      void this.save();
    }, AUTOSAVE_DELAY_MS);
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

export function getFileConflictCallout(snapshot: FileEditorSnapshot): FileConflictCallout | null {
  if (snapshot.status !== "conflict" || !snapshot.conflict) return null;
  if (snapshot.conflict === "deleted") return { kind: "deleted" };
  return { kind: "changed", canOverwrite: snapshot.modified };
}

function detectLineSeparator(content: string): FileLineSeparator {
  for (let index = 0; index < content.length; index += 1) {
    const character = content.charCodeAt(index);
    if (character === 10) return "\n";
    if (character === 13) return content.charCodeAt(index + 1) === 10 ? "\r\n" : "\r";
  }
  return "\n";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

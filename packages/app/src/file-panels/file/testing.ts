import type { FileWriteResult } from "@getpaseo/protocol/messages";
import type { FileContents, FileObservation, FileSession, FileTarget } from "./handle";

interface StoredFile {
  bytes: Uint8Array;
  revision: number;
}

/**
 * A file session over an in-memory disk, for tests. A write delivers its own observation before
 * it resolves, the order the daemon's watcher can produce.
 */
export class InMemoryFileSession implements FileSession {
  readonly createdUrls: string[] = [];
  readonly releasedUrls: string[] = [];
  readonly writes: string[] = [];
  private readonly files = new Map<string, StoredFile>();
  private readonly observers = new Set<{
    path: string;
    onObservation: (observation: FileObservation) => void;
  }>();
  private revision = 0;
  private urlCount = 0;
  private nextWriteError: string | null = null;

  /** The next write reports this error instead of writing. */
  failNextWrite(error: string): void {
    this.nextWriteError = error;
  }

  /** Writes the file as another program would. */
  put(path: string, content: string | Uint8Array): void {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    this.files.set(path, { bytes, revision: ++this.revision });
    this.notify(path);
  }

  remove(path: string): void {
    this.files.delete(path);
    this.notify(path);
  }

  text(path: string): string | null {
    const file = this.files.get(path);
    return file ? new TextDecoder("utf-8", { ignoreBOM: true }).decode(file.bytes) : null;
  }

  observerCount(): number {
    return this.observers.size;
  }

  async observe(target: FileTarget, onObservation: (observation: FileObservation) => void) {
    const observer = { path: target.path, onObservation };
    this.observers.add(observer);
    return {
      initial: this.observation(target.path),
      unsubscribe: () => {
        this.observers.delete(observer);
      },
    };
  }

  async read(target: FileTarget): Promise<FileContents> {
    const file = this.files.get(target.path);
    if (!file) throw new Error("File not found");
    return { bytes: file.bytes, ...version(file) };
  }

  async write(input: {
    target: FileTarget;
    content: string | Uint8Array;
    expectedModifiedAt: string;
    expectedRevision?: string;
  }): Promise<FileWriteResult> {
    if (this.nextWriteError) {
      const error = this.nextWriteError;
      this.nextWriteError = null;
      return { status: "error", error };
    }
    const file = this.files.get(input.target.path);
    if (!file) {
      return {
        status: "conflict",
        version: { status: "missing", cwd: "/", path: input.target.path },
      };
    }
    if (input.expectedRevision !== String(file.revision)) {
      return {
        status: "conflict",
        version: { status: "ready", cwd: "/", path: input.target.path, ...version(file) },
      };
    }
    this.writes.push(
      typeof input.content === "string" ? input.content : `bytes:${input.content.length}`,
    );
    this.put(input.target.path, input.content);
    const written = this.files.get(input.target.path)!;
    return { status: "written", ...version(written) };
  }

  async createUrl() {
    const url = `blob:test/${++this.urlCount}`;
    this.createdUrls.push(url);
    return { url, release: () => this.releasedUrls.push(url) };
  }

  private observation(path: string): FileObservation {
    const file = this.files.get(path);
    if (!file) return { status: "missing", cwd: "/", path };
    return { status: "ready", kind: "text", mimeType: "text/plain", ...version(file) };
  }

  private notify(path: string): void {
    const observation = this.observation(path);
    for (const observer of this.observers) {
      if (observer.path === path) observer.onObservation(observation);
    }
  }
}

function version(file: StoredFile) {
  return {
    size: file.bytes.length,
    modifiedAt: new Date(file.revision * 1000).toISOString(),
    revision: String(file.revision),
  };
}

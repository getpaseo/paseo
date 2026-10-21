import { useEffect, useState } from "react";

/**
 * The file a file panel shows. Stable for the life of the tab's target. The stat fields hold the
 * latest version Paseo knows; read them while rendering. Changing them does not re-render the
 * panel: `watch`, or a re-render from the read hooks, is how a panel learns they changed.
 */
export interface PluginFile {
  /** Absolute path on the host. */
  readonly path: string;
  readonly name: string;
  /** Lowercase, without the dot; empty when the name has none. */
  readonly extension: string;
  readonly size: number;
  readonly modifiedAt: string;
  readonly mimeType: string;
  /** Reads the file as UTF-8. A byte order mark is dropped here and written back by `writeText`. */
  readText(): Promise<string>;
  readBytes(): Promise<Uint8Array>;
  /**
   * A local URL of the file's current bytes, for `DocumentFrame` and images. Paseo owns it: it stays
   * valid until a URL of a newer version resolves or the tab closes.
   */
  url(): Promise<string>;
  /**
   * Writes the file if it has not changed since this handle last read or wrote it. Otherwise
   * rejects with `PluginFileConflictError`; `force: true` writes anyway. Rejects with
   * `PluginFileDeletedError` when the file is gone.
   */
  writeText(text: string, options?: PluginFileWriteOptions): Promise<void>;
  writeBytes(bytes: Uint8Array, options?: PluginFileWriteOptions): Promise<void>;
  /**
   * Calls `listener` when the file changes on disk or is deleted. This handle's own writes do not
   * notify. A deletion is reported once a read confirms it; the panel stays mounted. Returns the
   * unsubscribe function.
   */
  watch(listener: (event: PluginFileEvent) => void): () => void;
}

export interface PluginFileWriteOptions {
  force?: boolean;
}

/** What happened to the file on disk. Switch on `type`; later versions may add fields. */
export type PluginFileEvent = { type: "changed" } | { type: "deleted" };

/** What the panel reports back to its tab. */
export interface PluginFileTab {
  /** Shows the tab's unsaved dot and asks before the tab closes. */
  setModified(modified: boolean): void;
}

/** The line a link or search result opened the file at. `revision` bumps on every new target. */
export interface PluginFileLocation {
  lineStart?: number;
  lineEnd?: number;
  revision: number;
}

/** The file changed on disk since the handle last read or wrote it. */
export class PluginFileConflictError extends Error {
  constructor(message = "The file changed on disk.") {
    super(message);
    this.name = "PluginFileConflictError";
  }
}

/** The file was deleted on disk. */
export class PluginFileDeletedError extends Error {
  constructor(message = "The file was deleted.") {
    super(message);
    this.name = "PluginFileDeletedError";
  }
}

export type PluginFileTextState =
  | { status: "loading" }
  | { status: "ready"; text: string }
  | { status: "error"; error: Error };

export type PluginFileBytesState =
  | { status: "loading" }
  | { status: "ready"; bytes: Uint8Array }
  | { status: "error"; error: Error };

export type PluginFileUrlState =
  | { status: "loading" }
  | { status: "ready"; url: string }
  | { status: "error"; error: Error };

/**
 * The file's text, re-read when it changes on disk. Keeps the current text during a re-read. A
 * deleted file is an error holding a `PluginFileDeletedError`.
 */
export function useFileText(file: PluginFile): PluginFileTextState {
  const state = useFileRead(file, "text");
  return state.status === "ready" ? { status: "ready", text: state.value as string } : state;
}

/**
 * The file's bytes, re-read when it changes on disk. Keeps the current bytes during a re-read. A
 * deleted file is an error holding a `PluginFileDeletedError`.
 */
export function useFileBytes(file: PluginFile): PluginFileBytesState {
  const state = useFileRead(file, "bytes");
  return state.status === "ready" ? { status: "ready", bytes: state.value as Uint8Array } : state;
}

/**
 * A local URL of the file, replaced when it changes on disk. A deleted file is an error holding a
 * `PluginFileDeletedError`.
 */
export function useFileUrl(file: PluginFile): PluginFileUrlState {
  const state = useFileRead(file, "url");
  return state.status === "ready" ? { status: "ready", url: state.value as string } : state;
}

type FileRead = "text" | "bytes" | "url";
type FileReadState =
  | { status: "loading" }
  | { status: "ready"; value: string | Uint8Array }
  | { status: "error"; error: Error };

function useFileRead(file: PluginFile, read: FileRead): FileReadState {
  const [state, setState] = useState<{ file: PluginFile; read: FileRead; state: FileReadState }>(
    () => ({ file, read, state: { status: "loading" } }),
  );
  useEffect(() => {
    let generation = 0;
    let active = true;
    const load = async () => {
      const current = ++generation;
      let next: FileReadState;
      try {
        next = { status: "ready", value: await readFile(file, read) };
      } catch (error) {
        next = { status: "error", error: asError(error) };
      }
      if (active && current === generation) setState({ file, read, state: next });
    };
    void load();
    const unwatch = file.watch((event) => {
      if (event.type === "changed") {
        void load();
        return;
      }
      generation += 1;
      setState({
        file,
        read,
        state: { status: "error", error: new PluginFileDeletedError() },
      });
    });
    return () => {
      active = false;
      unwatch();
    };
  }, [file, read]);
  return state.file === file && state.read === read ? state.state : { status: "loading" };
}

function readFile(file: PluginFile, read: FileRead): Promise<string | Uint8Array> {
  if (read === "text") return file.readText();
  if (read === "bytes") return file.readBytes();
  return file.url();
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

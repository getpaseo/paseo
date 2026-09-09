import type {
  WorkspaceContentMatch,
  WorkspaceContentSearchResult,
} from "@getpaseo/protocol/messages";
import { explorerFileFromReadResult } from "@/file-explorer/read-result";
import type { FileReadResult } from "@getpaseo/client";
import type { WorkspaceFileLocation } from "@/workspace/file-open";

export interface ContentSearchTransport {
  searchWorkspaceContent(
    input: { cwd: string; query: string },
    options: { signal: AbortSignal },
  ): Promise<WorkspaceContentSearchResult>;
  readFile(
    cwd: string,
    path: string,
    requestId?: string,
    maxBytes?: number,
  ): Promise<FileReadResult>;
}
type Preview =
  | { status: "empty" | "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; path: string; content: string; size: number };
export interface ContentSearchSnapshot {
  query: string;
  status: "idle" | "searching" | "ready" | "error";
  message: string;
  matches: WorkspaceContentMatch[];
  limited: boolean;
  activeIndex: number;
  preview: Preview;
}

export class WorkspaceContentSearchModel {
  private snapshot: ContentSearchSnapshot = {
    query: "",
    status: "idle",
    message: "",
    matches: [],
    limited: false,
    activeIndex: 0,
    preview: { status: "empty" },
  };
  private listeners = new Set<() => void>();
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private reading = false;
  private file: { path: string; content: string; size: number } | null = null;
  constructor(
    private readonly options: {
      cwd: string;
      transport: ContentSearchTransport;
      open(location: WorkspaceFileLocation): void;
      debounceMs?: number;
    },
  ) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.snapshot;
  private update(next: Partial<ContentSearchSnapshot>) {
    this.snapshot = { ...this.snapshot, ...next };
    for (const listener of this.listeners) listener();
  }
  setQuery = (query: string) => {
    this.controller?.abort();
    this.file = null;
    clearTimeout(this.timer);
    this.update({
      query,
      status: query ? "searching" : "idle",
      message: "",
      matches: [],
      limited: false,
      activeIndex: 0,
      preview: { status: "empty" },
    });
    if (!query || this.disposed) return;
    const controller = new AbortController();
    this.controller = controller;
    this.timer = setTimeout(
      () => void this.search(query, controller),
      this.options.debounceMs ?? 100,
    );
  };
  private async search(query: string, controller: AbortController) {
    try {
      const result = await this.options.transport.searchWorkspaceContent(
        { cwd: this.options.cwd, query },
        { signal: controller.signal },
      );
      if (this.disposed || controller.signal.aborted) return;
      if (result.status === "error") {
        this.update({ status: "error", message: result.message });
        return;
      }
      this.update({ status: "ready", matches: result.matches, limited: result.limited });
      this.select(0);
    } catch (error) {
      if (!this.disposed && !controller.signal.aborted)
        this.update({
          status: "error",
          message: error instanceof Error ? error.message : "File search failed",
        });
    }
  }
  select = (index: number) => {
    const activeIndex = Math.max(0, Math.min(index, this.snapshot.matches.length - 1));
    this.update({ activeIndex });
    void this.preview();
  };
  move = (direction: number) =>
    this.select(
      (this.snapshot.activeIndex + direction + this.snapshot.matches.length) %
        (this.snapshot.matches.length || 1),
    );
  private async preview() {
    const match = this.snapshot.matches[this.snapshot.activeIndex];
    if (!match) return;
    if (this.file?.path === match.path) {
      this.update({
        preview: {
          status: "ready",
          ...this.file,
        },
      });
      return;
    }
    this.update({ preview: { status: "loading" } });
    if (this.reading) return;
    this.reading = true;
    const path = match.path;
    const query = this.controller;
    try {
      const file = await this.options.transport.readFile(
        this.options.cwd,
        path,
        undefined,
        1_048_576,
      );
      if (this.disposed) return;
      if (query === this.controller) {
        const content = explorerFileFromReadResult(file).content;
        if (content === undefined) throw new Error("This file is no longer text");
        this.file = {
          path,
          content,
          size: file.size,
        };
      }
    } catch (error) {
      if (
        !this.disposed &&
        query === this.controller &&
        this.snapshot.matches[this.snapshot.activeIndex]?.path === path
      ) {
        this.update({
          preview: {
            status: "error",
            message: error instanceof Error ? error.message : "Preview unavailable",
          },
        });
        return;
      }
    } finally {
      this.reading = false;
    }
    if (!this.disposed) void this.preview();
  }
  retry = () => {
    this.file = null;
    this.setQuery(this.snapshot.query);
  };
  retryPreview = () => {
    this.file = null;
    void this.preview();
  };
  openSelected = () => {
    const match = this.snapshot.matches[this.snapshot.activeIndex];
    if (!match || this.snapshot.status !== "ready") return;
    this.options.open({
      path: match.path,
      lineStart: match.line,
      columnStart: match.columnStart,
      columnEnd: match.columnEnd,
      expectedText: match.text,
    });
  };
  dispose = () => {
    this.disposed = true;
    this.controller?.abort();
    clearTimeout(this.timer);
    this.listeners.clear();
    this.file = null;
  };
}

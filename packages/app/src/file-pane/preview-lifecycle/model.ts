import type { FileReadResult } from "@getpaseo/client/internal/daemon-client";
import type { AttachmentMetadata } from "@/attachments/types";
import { persistAttachmentFromBytes } from "@/attachments/service";
import { createPreviewAttachmentId, getFileNameFromPath } from "@/attachments/utils";
import { explorerFileFromReadResult } from "@/file-explorer/read-result";
import type { ExplorerFile } from "@/stores/session-store";
import type { LiveFileSnapshot } from "../live-file/model";

export interface FilePanePreview {
  file: ExplorerFile;
  imageAttachment: AttachmentMetadata | null;
}

export type FilePreviewLifecycleSnapshot =
  | { status: "initial" }
  | { status: "read_pending" }
  | { status: "preparing" }
  | { status: "ready"; preview: FilePanePreview }
  | { status: "error"; message: string }
  | { status: "unsupported" };

const initialSnapshot: FilePreviewLifecycleSnapshot = { status: "initial" };

/** Converts a completed raw read into the preview resources consumed by FilePane. */
export async function createFilePanePreview(file: FileReadResult): Promise<FilePanePreview | null> {
  const explorerFile = explorerFileFromReadResult(file);
  if (file.kind !== "image") {
    return { file: explorerFile, imageAttachment: null };
  }

  const imageAttachment = await persistAttachmentFromBytes({
    id: createPreviewAttachmentId({
      mimeType: file.mime,
      path: file.path,
      size: file.size,
      modifiedAt: file.modifiedAt,
      contentLength: file.bytes.byteLength,
    }),
    bytes: file.bytes,
    mimeType: file.mime,
    fileName: getFileNameFromPath(file.path),
  });

  return { file: explorerFile, imageAttachment };
}

/** Owns conversion after LiveFileModel has produced a raw file snapshot. */
export class FilePreviewLifecycleModel {
  private readonly listeners = new Set<() => void>();
  private snapshot: FilePreviewLifecycleSnapshot = initialSnapshot;
  private generation = 0;
  private preparedSourceKey: string | null = null;

  constructor(
    private readonly prepare: (file: FileReadResult) => Promise<FilePanePreview | null>,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): FilePreviewLifecycleSnapshot => this.snapshot;

  setSource(input: { targetKey: string | null; liveFileSnapshot: LiveFileSnapshot }): void {
    const source = getReadySource(input);
    if (source) {
      if (source.key === this.preparedSourceKey) {
        return;
      }
      this.preparedSourceKey = source.key;
      const generation = ++this.generation;
      this.setSnapshot({ status: "preparing" });
      void this.prepareSource({ file: source.file, generation });
      return;
    }

    const nextSnapshot = getNonReadySnapshot(input.liveFileSnapshot);
    if (sameNonReadyState(this.snapshot, nextSnapshot)) {
      return;
    }
    this.preparedSourceKey = null;
    this.generation += 1;
    this.setSnapshot(nextSnapshot);
  }

  private setSnapshot(snapshot: FilePreviewLifecycleSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  private async prepareSource(input: { file: FileReadResult; generation: number }): Promise<void> {
    try {
      const preview = await this.prepare(input.file);
      if (input.generation !== this.generation) return;
      this.setSnapshot(preview ? { status: "ready", preview } : { status: "unsupported" });
    } catch (error) {
      if (input.generation !== this.generation) return;
      this.setSnapshot({ status: "error", message: errorMessage(error) });
    }
  }
}

function getReadySource(input: {
  targetKey: string | null;
  liveFileSnapshot: LiveFileSnapshot;
}): { key: string; file: FileReadResult } | null {
  const observation = input.liveFileSnapshot.observation;
  if (!input.targetKey || observation?.status !== "ready") {
    return null;
  }
  const { version } = observation;
  if (input.targetKey !== `${version.cwd}:${version.path}`) {
    return null;
  }
  return {
    key: `${input.targetKey}:${version.revision ?? version.modifiedAt}:${version.size}`,
    file: observation.file,
  };
}

function getNonReadySnapshot(snapshot: LiveFileSnapshot): FilePreviewLifecycleSnapshot {
  if (snapshot.read.status === "error") {
    return { status: "error", message: snapshot.read.error };
  }
  if (snapshot.observation?.status === "error") {
    return { status: "error", message: snapshot.observation.error };
  }
  if (snapshot.observation?.status === "missing") {
    return { status: "error", message: "File not found" };
  }
  if (snapshot.read.status === "pending") {
    return { status: "read_pending" };
  }
  return initialSnapshot;
}

function sameNonReadyState(
  current: FilePreviewLifecycleSnapshot,
  next: FilePreviewLifecycleSnapshot,
): boolean {
  if (current.status !== next.status) {
    return false;
  }
  return current.status !== "error" || next.status !== "error" || current.message === next.message;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Failed to prepare preview";
}

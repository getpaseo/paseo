import { FILE_UPLOAD_MAX_BYTES } from "@/attachments/upload-limit";
import { prepareTerminalPath } from "../drop/terminal-path";

/** File bytes from a paste or drop gesture, before they become a file on the host. */
export interface TerminalFile {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}

/** A file over the upload limit; the pane words it for the user. */
export class TerminalFileTooLargeError extends Error {
  constructor(readonly fileName: string) {
    super(`${fileName} exceeds the upload limit`);
  }
}

/** The pane's host and terminal: where a file is stored and where its path is pasted. */
export interface TerminalFilePasteTarget {
  /** Stores the file on the host and returns its host path. */
  upload(file: TerminalFile): Promise<string>;
  paste(text: string): void;
}

interface TerminalFilePasteEvents {
  onUploadingChange(uploading: boolean): void;
  onUploaded(): void;
  onFailure(error: unknown): void;
}

/**
 * Turns a pane's file gestures into pasted host paths, one at a time and in
 * gesture order. Ordinary input never waits on it.
 */
export class TerminalFilePasteQueue {
  private tail: Promise<void> = Promise.resolve();
  private generation = 0;
  private pending = 0;
  private uploading = false;

  constructor(private readonly events: TerminalFilePasteEvents) {}

  /** Queues a gesture. `file` resolves to null when the gesture carried no file. */
  add(file: Promise<TerminalFile | null>, target: TerminalFilePasteTarget): void {
    const generation = this.generation;
    this.pending += 1;
    this.tail = this.tail.then(() => this.paste(file, target, generation));
  }

  /** Drops queued and in-flight gestures. Returns whether any were dropped. */
  cancel(): boolean {
    const dropped = this.pending > 0;
    this.generation += 1;
    this.pending = 0;
    // A cancelled upload can stay unsettled until its connection resolves.
    this.tail = Promise.resolve();
    this.setUploading(false);
    return dropped;
  }

  private async paste(
    read: Promise<TerminalFile | null>,
    target: TerminalFilePasteTarget,
    generation: number,
  ): Promise<void> {
    const isCurrent = () => generation === this.generation;
    try {
      const file = await read;
      if (!file || !isCurrent()) {
        return;
      }
      if (file.bytes.byteLength > FILE_UPLOAD_MAX_BYTES) {
        throw new TerminalFileTooLargeError(file.fileName);
      }
      this.setUploading(true);
      const path = await target.upload({ ...file, fileName: toShellSafeFileName(file.fileName) });
      if (isCurrent()) {
        target.paste(prepareTerminalPath(path));
        this.events.onUploaded();
      }
    } catch (error) {
      if (isCurrent()) {
        this.events.onFailure(error);
      }
    } finally {
      if (isCurrent()) {
        this.pending -= 1;
        this.setUploading(false);
      }
    }
  }

  private setUploading(uploading: boolean): void {
    if (this.uploading === uploading) {
      return;
    }
    this.uploading = uploading;
    this.events.onUploadingChange(uploading);
  }
}

// The host path is pasted into a shell or TUI; keep its last segment unquotable.
function toShellSafeFileName(fileName: string): string {
  return fileName.replace(/[^\w.-]/g, "_");
}

export async function readTerminalFile(file: File): Promise<TerminalFile> {
  return {
    fileName: file.name,
    mimeType: file.type,
    bytes: new Uint8Array(await file.arrayBuffer()),
  };
}

export function terminalFileFromBase64(input: {
  fileName: string;
  mimeType: string;
  data: string;
}): TerminalFile {
  const binary = atob(input.data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return { fileName: input.fileName, mimeType: input.mimeType, bytes };
}

/** File extension for a clipboard image, which arrives as bytes with only a MIME type. */
export function imageExtension(mimeType: string): string {
  const subtype = mimeType.split("/")[1]?.split(/[+;]/)[0] ?? "";
  if (subtype === "jpeg") {
    return "jpg";
  }
  return subtype || "png";
}

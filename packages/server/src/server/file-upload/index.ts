import { randomUUID } from "node:crypto";
import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { FileTransferOpcode, type FileTransferFrame } from "@getpaseo/protocol/binary-frames/index";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import type { FileUploadRequest, FileUploadResponse } from "../messages.js";

interface FileUploadStoreOptions {
  paseoHome: string;
  staleUploadTimeoutMs?: number;
}

interface PendingUpload {
  requestId: string;
  id: string;
  source: object;
  completed: boolean;
  finished(response: FileUploadResponse | null): void;
  fileName: string;
  mimeType: string;
  size: number;
  path: string;
  receivedBytes: number;
  started: boolean;
  staleTimeout: ReturnType<typeof setTimeout>;
  queue: Promise<void>;
  cleanup?: Promise<void>;
}

export class FileUploadStore {
  private static readonly defaultStaleUploadTimeoutMs = 10 * 60 * 1000;

  private readonly paseoHome: string;
  private readonly staleUploadTimeoutMs: number;
  private readonly defaultSource = {};
  private readonly pending = new Map<object, Map<string, PendingUpload>>();

  constructor(options: FileUploadStoreOptions) {
    this.paseoHome = options.paseoHome;
    this.staleUploadTimeoutMs =
      options.staleUploadTimeoutMs ?? FileUploadStore.defaultStaleUploadTimeoutMs;
  }

  beginUpload(
    request: FileUploadRequest,
    source: object = this.defaultSource,
    finished: (response: FileUploadResponse | null) => void = () => {},
  ): () => Promise<void> {
    const existingUpload = this.pending.get(source)?.get(request.requestId);
    if (existingUpload) void this.cancel(existingUpload).catch(() => {});
    const fileName = sanitizeFileName(request.fileName);
    const id = `upload_${randomUUID()}`;
    const uploadDir = join(this.paseoHome, "uploads", id);
    const upload: PendingUpload = {
      requestId: request.requestId,
      id,
      source,
      completed: false,
      finished,
      fileName,
      mimeType: request.mimeType,
      size: request.size,
      path: join(uploadDir, fileName),
      receivedBytes: 0,
      started: false,
      staleTimeout: this.createStaleUploadTimeout(source, request.requestId),
      queue: Promise.resolve(),
    };
    const uploads = this.pending.get(source) ?? new Map<string, PendingUpload>();
    uploads.set(request.requestId, upload);
    this.pending.set(source, uploads);
    return () => this.cancel(upload);
  }

  async receiveFrame(
    frame: FileTransferFrame,
    source: object = this.defaultSource,
  ): Promise<FileUploadResponse | null> {
    const upload = this.pending.get(source)?.get(frame.requestId);
    if (!upload) {
      return null;
    }
    this.refreshStaleUploadTimeout(upload);

    const operation = upload.queue.then(() => this.applyFrame(upload, frame));
    void operation.then(
      (response) => {
        if (response) upload.finished(response);
        return undefined;
      },
      () => upload.finished(null),
    );
    upload.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async applyFrame(
    upload: PendingUpload,
    frame: FileTransferFrame,
  ): Promise<FileUploadResponse | null> {
    if (this.pending.get(upload.source)?.get(upload.requestId) !== upload) {
      return null;
    }

    try {
      if (frame.opcode === FileTransferOpcode.FileBegin) {
        await this.startWriting(upload);
        return null;
      }
      if (frame.opcode === FileTransferOpcode.FileChunk) {
        await this.writeChunk(upload, frame.payload);
        return null;
      }
      return await this.completeUpload(upload);
    } catch (error) {
      await this.removeFailedUpload(upload);
      return buildUploadResponse(upload, getErrorMessage(error));
    }
  }

  private async startWriting(upload: PendingUpload): Promise<void> {
    await mkdir(join(this.paseoHome, "uploads", upload.id), { recursive: true });
    await writeFile(upload.path, new Uint8Array());
    upload.started = true;
  }

  private async writeChunk(upload: PendingUpload, bytes: Uint8Array): Promise<void> {
    if (!upload.started) {
      throw new Error("Upload chunks arrived before file begin.");
    }
    const nextReceivedBytes = upload.receivedBytes + bytes.byteLength;
    if (nextReceivedBytes > upload.size) {
      throw new Error(
        `Upload exceeded declared size: expected ${upload.size}, received ${nextReceivedBytes}.`,
      );
    }
    await appendFile(upload.path, bytes);
    upload.receivedBytes += bytes.byteLength;
  }

  private async completeUpload(upload: PendingUpload): Promise<FileUploadResponse> {
    this.clearPendingUpload(upload);
    if (upload.receivedBytes !== upload.size) {
      await this.removeUploadDirectory(upload);
      return buildUploadResponse(
        upload,
        `Upload size mismatch: expected ${upload.size}, received ${upload.receivedBytes}.`,
      );
    }
    upload.completed = true;
    return buildUploadResponse(upload, null);
  }

  private createStaleUploadTimeout(
    source: object,
    requestId: string,
  ): ReturnType<typeof setTimeout> {
    const timeout = setTimeout(() => {
      const upload = this.pending.get(source)?.get(requestId);
      if (upload) void this.cancel(upload).catch(() => {});
    }, this.staleUploadTimeoutMs);
    timeout.unref?.();
    return timeout;
  }

  private refreshStaleUploadTimeout(upload: PendingUpload): void {
    clearTimeout(upload.staleTimeout);
    upload.staleTimeout = this.createStaleUploadTimeout(upload.source, upload.requestId);
  }

  private cancel(upload: PendingUpload): Promise<void> {
    if (upload.cleanup) return upload.cleanup;
    this.clearPendingUpload(upload);
    upload.cleanup = upload.queue.then(async () => {
      if (!upload.completed) await this.removeUploadDirectory(upload);
      return undefined;
    });
    upload.finished(null);
    return upload.cleanup;
  }

  private clearPendingUpload(upload: PendingUpload): void {
    clearTimeout(upload.staleTimeout);
    const uploads = this.pending.get(upload.source);
    if (uploads?.get(upload.requestId) === upload) uploads.delete(upload.requestId);
    if (uploads?.size === 0) this.pending.delete(upload.source);
  }

  private async removeFailedUpload(upload: PendingUpload): Promise<void> {
    this.clearPendingUpload(upload);
    await this.removeUploadDirectory(upload);
  }

  private async removeUploadDirectory(upload: PendingUpload): Promise<void> {
    await rm(join(this.paseoHome, "uploads", upload.id), { recursive: true, force: true });
  }
}

function buildUploadResponse(upload: PendingUpload, error: string | null): FileUploadResponse {
  return {
    type: "file.upload.response",
    payload: {
      requestId: upload.requestId,
      file: error
        ? null
        : {
            type: "uploaded_file",
            id: upload.id,
            fileName: upload.fileName,
            mimeType: upload.mimeType,
            size: upload.size,
            path: upload.path,
          },
      error,
    },
  };
}

function sanitizeFileName(value: string): string {
  const name = basename(value)
    .replace(/[^a-zA-Z0-9._ -]/g, "_")
    .trim();
  return name.length > 0 && name !== "." && name !== ".." ? name : "upload";
}

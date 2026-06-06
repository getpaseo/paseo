import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { FileTransferOpcode, type FileTransferFrame } from "@getpaseo/protocol/binary-frames/index";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import type { FileUploadRequest, FileUploadResponse } from "../messages.js";

interface FileUploadStoreOptions {
  paseoHome: string;
}

interface PendingUpload {
  requestId: string;
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  path: string;
  receivedBytes: number;
  started: boolean;
}

export class FileUploadStore {
  private readonly paseoHome: string;
  private readonly pending = new Map<string, PendingUpload>();

  constructor(options: FileUploadStoreOptions) {
    this.paseoHome = options.paseoHome;
  }

  beginUpload(request: FileUploadRequest): void {
    const fileName = sanitizeFileName(request.fileName);
    const id = `upload_${sanitizeUploadId(request.requestId)}`;
    const uploadDir = join(this.paseoHome, "uploads", id);
    this.pending.set(request.requestId, {
      requestId: request.requestId,
      id,
      fileName,
      mimeType: request.mimeType,
      size: request.size,
      path: join(uploadDir, fileName),
      receivedBytes: 0,
      started: false,
    });
  }

  receiveFrame(frame: FileTransferFrame): FileUploadResponse | null {
    const upload = this.pending.get(frame.requestId);
    if (!upload) {
      return null;
    }

    try {
      if (frame.opcode === FileTransferOpcode.FileBegin) {
        this.startWriting(upload);
        return null;
      }
      if (frame.opcode === FileTransferOpcode.FileChunk) {
        this.writeChunk(upload, frame.payload);
        return null;
      }
      return this.completeUpload(upload);
    } catch (error) {
      this.pending.delete(frame.requestId);
      return buildUploadResponse(upload, getErrorMessage(error));
    }
  }

  private startWriting(upload: PendingUpload): void {
    mkdirSync(join(this.paseoHome, "uploads", upload.id), { recursive: true });
    writeFileSync(upload.path, new Uint8Array());
    upload.started = true;
  }

  private writeChunk(upload: PendingUpload, bytes: Uint8Array): void {
    if (!upload.started) {
      throw new Error("Upload chunks arrived before file begin.");
    }
    appendFileSync(upload.path, bytes);
    upload.receivedBytes += bytes.byteLength;
  }

  private completeUpload(upload: PendingUpload): FileUploadResponse {
    this.pending.delete(upload.requestId);
    if (upload.receivedBytes !== upload.size) {
      return buildUploadResponse(
        upload,
        `Upload size mismatch: expected ${upload.size}, received ${upload.receivedBytes}.`,
      );
    }
    return buildUploadResponse(upload, null);
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

function sanitizeUploadId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_") || "file";
}

function sanitizeFileName(value: string): string {
  const name = basename(value)
    .replace(/[^a-zA-Z0-9._ -]/g, "_")
    .trim();
  return name.length > 0 && name !== "." && name !== ".." ? name : "upload";
}

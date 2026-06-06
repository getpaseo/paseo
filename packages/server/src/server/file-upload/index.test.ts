import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  decodeFileTransferFrame,
  encodeFileTransferFrame,
  FileTransferOpcode,
  type FileTransferFrame,
} from "@getpaseo/protocol/binary-frames/index";
import { FileUploadStore } from "./index.js";

const tempDirs: string[] = [];

describe("file uploads", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stores chunked upload bytes and returns an uploaded-file attachment", async () => {
    const paseoHome = makePaseoHome();
    const uploads = new FileUploadStore({ paseoHome });

    uploads.beginUpload({
      type: "file.upload.request",
      fileName: "notes.txt",
      mimeType: "text/plain",
      size: 11,
      modifiedAt: "2026-05-02T00:00:00.000Z",
      requestId: "req-upload",
    });
    await expect(uploads.receiveFrame(uploadBegins("req-upload"))).resolves.toBeNull();
    await expect(uploads.receiveFrame(uploadChunk("req-upload", "hello"))).resolves.toBeNull();
    await expect(uploads.receiveFrame(uploadChunk("req-upload", " world"))).resolves.toBeNull();

    const path = join(paseoHome, "uploads", "upload_req-upload", "notes.txt");
    await expect(uploads.receiveFrame(uploadEnds("req-upload"))).resolves.toEqual({
      type: "file.upload.response",
      payload: {
        requestId: "req-upload",
        file: {
          type: "uploaded_file",
          id: "upload_req-upload",
          fileName: "notes.txt",
          mimeType: "text/plain",
          size: 11,
          path,
        },
        error: null,
      },
    });
    expect(readFileSync(path, "utf8")).toBe("hello world");
  });

  it("rejects chunks beyond the declared size and removes the partial file", async () => {
    const paseoHome = makePaseoHome();
    const uploads = new FileUploadStore({ paseoHome });

    uploads.beginUpload({
      type: "file.upload.request",
      fileName: "notes.txt",
      mimeType: "text/plain",
      size: 5,
      modifiedAt: "2026-05-02T00:00:00.000Z",
      requestId: "req-overflow",
    });
    await expect(uploads.receiveFrame(uploadBegins("req-overflow"))).resolves.toBeNull();

    const path = join(paseoHome, "uploads", "upload_req-overflow", "notes.txt");
    await expect(uploads.receiveFrame(uploadChunk("req-overflow", "hello!"))).resolves.toEqual({
      type: "file.upload.response",
      payload: {
        requestId: "req-overflow",
        file: null,
        error: "Upload exceeded declared size: expected 5, received 6.",
      },
    });
    expect(existsSync(path)).toBe(false);
  });

  it("preserves chunk order when frames arrive before earlier disk writes finish", async () => {
    const paseoHome = makePaseoHome();
    const uploads = new FileUploadStore({ paseoHome });

    uploads.beginUpload({
      type: "file.upload.request",
      fileName: "notes.txt",
      mimeType: "text/plain",
      size: 11,
      modifiedAt: "2026-05-02T00:00:00.000Z",
      requestId: "req-queued",
    });

    const results = await Promise.all([
      uploads.receiveFrame(uploadBegins("req-queued")),
      uploads.receiveFrame(uploadChunk("req-queued", "hello")),
      uploads.receiveFrame(uploadChunk("req-queued", " world")),
      uploads.receiveFrame(uploadEnds("req-queued")),
    ]);

    expect(results.slice(0, 3)).toEqual([null, null, null]);
    expect(results[3]?.payload.error).toBeNull();
    expect(readFileSync(join(paseoHome, "uploads", "upload_req-queued", "notes.txt"), "utf8")).toBe(
      "hello world",
    );
  });
});

function makePaseoHome(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "file-upload-test-")));
  tempDirs.push(root);
  return root;
}

function uploadBegins(requestId: string): FileTransferFrame {
  return decodeUploadFrame(
    encodeFileTransferFrame({
      opcode: FileTransferOpcode.FileBegin,
      requestId,
      metadata: {
        mime: "text/plain",
        size: 11,
        encoding: "binary",
        modifiedAt: "2026-05-02T00:00:00.000Z",
        fileName: "notes.txt",
      },
    }),
  );
}

function uploadChunk(requestId: string, text: string): FileTransferFrame {
  return decodeUploadFrame(
    encodeFileTransferFrame({
      opcode: FileTransferOpcode.FileChunk,
      requestId,
      payload: new TextEncoder().encode(text),
    }),
  );
}

function uploadEnds(requestId: string): FileTransferFrame {
  return decodeUploadFrame(
    encodeFileTransferFrame({
      opcode: FileTransferOpcode.FileEnd,
      requestId,
    }),
  );
}

function decodeUploadFrame(bytes: Uint8Array): FileTransferFrame {
  const frame = decodeFileTransferFrame(bytes);
  if (!frame) {
    throw new Error("Expected file transfer frame");
  }
  return frame;
}

import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
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

  it("stores chunked upload bytes and returns an uploaded-file attachment", () => {
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
    expect(uploads.receiveFrame(uploadBegins("req-upload"))).toBeNull();
    expect(uploads.receiveFrame(uploadChunk("req-upload", "hello"))).toBeNull();
    expect(uploads.receiveFrame(uploadChunk("req-upload", " world"))).toBeNull();

    const path = join(paseoHome, "uploads", "upload_req-upload", "notes.txt");
    expect(uploads.receiveFrame(uploadEnds("req-upload"))).toEqual({
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

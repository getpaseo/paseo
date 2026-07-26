import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import pino from "pino";
import {
  decodeFileTransferFrame,
  encodeFileTransferFrame,
  FileTransferOpcode,
  type FileTransferFrame,
} from "@getpaseo/protocol/binary-frames/index";
import {
  WorkspaceFilesSession,
  type WorkspaceFilesSessionHost,
} from "./workspace-files-session.js";
import { DownloadTokenStore } from "../../file-download/token-store.js";
import { MAX_PREVIEWABLE_FILE_BYTES } from "../../file-explorer/service.js";
import { FILE_TRANSFER_CHUNK_BYTES } from "./file-transfer-emitter.js";
import type { SessionOutboundMessage } from "../../messages.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

function makeSubsystem(options: { hasBinaryChannel?: boolean } = {}) {
  const emitted: SessionOutboundMessage[] = [];
  const binary: Uint8Array[] = [];
  let hasBinary = options.hasBinaryChannel ?? false;
  const host: WorkspaceFilesSessionHost = {
    emit: (msg) => emitted.push(msg),
    emitBinary: (frame) => binary.push(frame),
    hasBinaryChannel: () => hasBinary,
    // A drained client; chunk pacing has its own tests in file-transfer-emitter.
    getClientBufferedAmount: () => 0,
  };
  const paseoHome = makeDir("workspace-files-home-");
  const subsystem = new WorkspaceFilesSession({
    host,
    downloadTokenStore: new DownloadTokenStore({ ttlMs: 60_000 }),
    paseoHome,
    logger: pino({ level: "silent" }),
  });
  return {
    subsystem,
    emitted,
    binary,
    paseoHome,
    setHasBinary: (value: boolean) => {
      hasBinary = value;
    },
  };
}

function uploadFrame(args: Parameters<typeof encodeFileTransferFrame>[0]): FileTransferFrame {
  const frame = decodeFileTransferFrame(encodeFileTransferFrame(args));
  if (!frame) {
    throw new Error("Expected a file transfer frame");
  }
  return frame;
}

describe("WorkspaceFilesSession", () => {
  test("lists directory entries", async () => {
    const cwd = makeDir("workspace-files-list-");
    writeFileSync(join(cwd, "a.txt"), "alpha");
    const { subsystem, emitted } = makeSubsystem();

    await subsystem.handleFileExplorerRequest({
      type: "file_explorer_request",
      cwd,
      path: ".",
      mode: "list",
      requestId: "req-list",
    });

    expect(emitted).toHaveLength(1);
    const message = emitted[0];
    if (message.type !== "file_explorer_response") {
      throw new Error(`expected file_explorer_response, got ${message.type}`);
    }
    expect(message.payload.error).toBeNull();
    expect(message.payload.directory).not.toBeNull();
  });

  test("reads file content inline when the client has no binary channel", async () => {
    const cwd = makeDir("workspace-files-read-");
    writeFileSync(join(cwd, "notes.txt"), "hello world");
    const { subsystem, emitted, binary } = makeSubsystem({ hasBinaryChannel: false });

    await subsystem.handleFileExplorerRequest({
      type: "file_explorer_request",
      cwd,
      path: "notes.txt",
      mode: "file",
      requestId: "req-read",
      acceptBinary: true,
    });

    expect(binary).toEqual([]);
    expect(emitted).toHaveLength(1);
    const message = emitted[0];
    if (message.type !== "file_explorer_response") {
      throw new Error(`expected file_explorer_response, got ${message.type}`);
    }
    expect(message.payload.error).toBeNull();
    expect(message.payload.file).not.toBeNull();
  });

  test("streams binary frames when the client accepts binary and has a channel", async () => {
    const cwd = makeDir("workspace-files-binary-");
    writeFileSync(join(cwd, "notes.txt"), "hello world");
    const { subsystem, emitted, binary } = makeSubsystem({ hasBinaryChannel: true });

    await subsystem.handleFileExplorerRequest({
      type: "file_explorer_request",
      cwd,
      path: "notes.txt",
      mode: "file",
      requestId: "req-binary",
      acceptBinary: true,
    });

    expect(emitted).toEqual([]);
    expect(binary).toHaveLength(3);
    const opcodes = binary.map((frame) => decodeFileTransferFrame(frame)?.opcode);
    expect(opcodes).toEqual([
      FileTransferOpcode.FileBegin,
      FileTransferOpcode.FileChunk,
      FileTransferOpcode.FileEnd,
    ]);
  });

  test("splits a large file across chunk frames that reassemble to the file", async () => {
    const cwd = makeDir("workspace-files-chunked-");
    const contents = Buffer.alloc(700 * 1024);
    for (let index = 0; index < contents.length; index += 1) {
      contents[index] = index % 256;
    }
    writeFileSync(join(cwd, "large.bin"), contents);
    const { subsystem, binary } = makeSubsystem({ hasBinaryChannel: true });

    await subsystem.handleFileExplorerRequest({
      type: "file_explorer_request",
      cwd,
      path: "large.bin",
      mode: "file",
      requestId: "req-chunked",
      acceptBinary: true,
    });

    const decoded = binary.map((frame) => {
      const value = decodeFileTransferFrame(frame);
      if (!value) throw new Error("undecodable frame");
      return value;
    });
    const chunks = decoded.filter((frame) => frame.opcode === FileTransferOpcode.FileChunk);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.payload.byteLength).toBeLessThanOrEqual(FILE_TRANSFER_CHUNK_BYTES);
    }
    expect(decoded[0].opcode).toBe(FileTransferOpcode.FileBegin);
    expect(decoded[decoded.length - 1].opcode).toBe(FileTransferOpcode.FileEnd);
    expect(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.payload)))).toEqual(contents);
  });

  test("reads a pdf as binary with an application/pdf mime", async () => {
    const cwd = makeDir("workspace-files-pdf-");
    writeFileSync(join(cwd, "doc.pdf"), "%PDF-1.7\n1 0 obj\n<< >>\nendobj\n%%EOF\n");
    const { subsystem, binary } = makeSubsystem({ hasBinaryChannel: true });

    await subsystem.handleFileExplorerRequest({
      type: "file_explorer_request",
      cwd,
      path: "doc.pdf",
      mode: "file",
      requestId: "req-pdf",
      acceptBinary: true,
    });

    const begin = decodeFileTransferFrame(binary[0]);
    if (begin?.opcode !== FileTransferOpcode.FileBegin) {
      throw new Error("expected a FileBegin frame");
    }
    expect(begin.metadata.mime).toBe("application/pdf");
    expect(begin.metadata.encoding).toBe("binary");
  });

  test("refuses to read a file past the preview size bound", async () => {
    const cwd = makeDir("workspace-files-toolarge-");
    const filePath = join(cwd, "huge.bin");
    writeFileSync(filePath, "");
    // Sparse: the cap is checked against stat before any bytes are read.
    truncateSync(filePath, MAX_PREVIEWABLE_FILE_BYTES + 1);
    const { subsystem, emitted, binary } = makeSubsystem({ hasBinaryChannel: true });

    await subsystem.handleFileExplorerRequest({
      type: "file_explorer_request",
      cwd,
      path: "huge.bin",
      mode: "file",
      requestId: "req-huge",
      acceptBinary: true,
    });

    expect(binary).toEqual([]);
    const message = emitted[0];
    if (message?.type !== "file_explorer_response") {
      throw new Error(`expected file_explorer_response, got ${message?.type}`);
    }
    expect(message.payload.error).toContain("too large to preview");
  });

  test("rejects an empty file-explorer cwd with an error envelope", async () => {
    const { subsystem, emitted } = makeSubsystem();

    await subsystem.handleFileExplorerRequest({
      type: "file_explorer_request",
      cwd: "  ",
      path: ".",
      mode: "list",
      requestId: "req-empty",
    });

    expect(emitted).toEqual([
      {
        type: "file_explorer_response",
        payload: expect.objectContaining({
          error: "cwd is required",
          directory: null,
          file: null,
          requestId: "req-empty",
        }),
      },
    ]);
  });

  test("issues a download token for a real file", async () => {
    const cwd = makeDir("workspace-files-token-");
    writeFileSync(join(cwd, "report.txt"), "hello world");
    const { subsystem, emitted } = makeSubsystem();

    await subsystem.handleFileDownloadTokenRequest({
      type: "file_download_token_request",
      cwd,
      path: "report.txt",
      requestId: "req-token",
    });

    expect(emitted).toHaveLength(1);
    const message = emitted[0];
    if (message.type !== "file_download_token_response") {
      throw new Error(`expected file_download_token_response, got ${message.type}`);
    }
    expect(message.payload.error).toBeNull();
    expect(typeof message.payload.token).toBe("string");
    expect(message.payload.fileName).toBe("report.txt");
    expect(message.payload.size).toBe(11);
  });

  test("rejects an empty download-token cwd with an error envelope", async () => {
    const { subsystem, emitted } = makeSubsystem();

    await subsystem.handleFileDownloadTokenRequest({
      type: "file_download_token_request",
      cwd: "",
      path: "report.txt",
      requestId: "req-token-empty",
    });

    expect(emitted).toEqual([
      {
        type: "file_download_token_response",
        payload: expect.objectContaining({
          token: null,
          error: "cwd is required",
          requestId: "req-token-empty",
        }),
      },
    ]);
  });

  test("responds to a project icon request", async () => {
    const cwd = makeDir("workspace-files-icon-");
    const { subsystem, emitted } = makeSubsystem();

    await subsystem.handleProjectIconRequest({
      type: "project_icon_request",
      cwd,
      requestId: "req-icon",
    });

    expect(emitted).toHaveLength(1);
    const message = emitted[0];
    if (message.type !== "project_icon_response") {
      throw new Error(`expected project_icon_response, got ${message.type}`);
    }
    expect(message.payload.cwd).toBe(cwd);
    expect(message.payload.error).toBeNull();
  });

  test("round-trips an upload through transfer frames", async () => {
    const { subsystem, emitted, paseoHome } = makeSubsystem();

    subsystem.handleFileUploadRequest({
      type: "file.upload.request",
      fileName: "notes.txt",
      mimeType: "text/plain",
      size: 11,
      modifiedAt: "2026-05-02T00:00:00.000Z",
      requestId: "req-upload",
    });
    await subsystem.handleFileTransferFrame(
      uploadFrame({
        opcode: FileTransferOpcode.FileBegin,
        requestId: "req-upload",
        metadata: {
          mime: "text/plain",
          size: 11,
          encoding: "binary",
          modifiedAt: "2026-05-02T00:00:00.000Z",
          fileName: "notes.txt",
        },
      }),
    );
    await subsystem.handleFileTransferFrame(
      uploadFrame({
        opcode: FileTransferOpcode.FileChunk,
        requestId: "req-upload",
        payload: new TextEncoder().encode("hello world"),
      }),
    );
    await subsystem.handleFileTransferFrame(
      uploadFrame({ opcode: FileTransferOpcode.FileEnd, requestId: "req-upload" }),
    );

    const message = emitted.find((entry) => entry.type === "file.upload.response");
    if (message?.type !== "file.upload.response") {
      throw new Error("expected a file.upload.response message");
    }
    expect(message.payload.error).toBeNull();
    expect(message.payload.file?.fileName).toBe("notes.txt");
    expect(readFileSync(join(paseoHome, "uploads", "upload_req-upload", "notes.txt"), "utf8")).toBe(
      "hello world",
    );
  });
});

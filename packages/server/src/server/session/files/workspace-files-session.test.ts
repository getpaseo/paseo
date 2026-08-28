import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
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

function makeSubsystem(
  options: {
    hasBinaryChannel?: boolean;
    emitBinary?: (frame: Uint8Array) => Promise<void> | void;
    uploadIdleTimeoutMs?: number;
  } = {},
) {
  const emitted: SessionOutboundMessage[] = [];
  const binary: Uint8Array[] = [];
  let hasBinary = options.hasBinaryChannel ?? false;
  const host: WorkspaceFilesSessionHost = {
    emit: (msg) => emitted.push(msg),
    emitBinary: async (frame) => {
      binary.push(frame);
      await options.emitBinary?.(frame);
    },
    hasBinaryChannel: () => hasBinary,
  };
  const paseoHome = makeDir("workspace-files-home-");
  const subsystem = new WorkspaceFilesSession({
    host,
    downloadTokenStore: new DownloadTokenStore({ ttlMs: 60_000 }),
    paseoHome,
    logger: pino({ level: "silent" }),
    ...(options.uploadIdleTimeoutMs !== undefined
      ? { uploadIdleTimeoutMs: options.uploadIdleTimeoutMs }
      : {}),
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
  test("creates an entry and emits the complete success response", async () => {
    const cwd = makeDir("workspace-files-create-");
    const { subsystem, emitted } = makeSubsystem();

    await subsystem.handleFileEntryCreateRequest({
      type: "fs.entry.create.request",
      cwd,
      parentPath: ".",
      name: "notes.txt",
      kind: "file",
      requestId: "req-create",
    });

    expect(existsSync(join(cwd, "notes.txt"))).toBe(true);
    expect(emitted).toEqual([
      {
        type: "fs.entry.create.response",
        payload: {
          cwd,
          parentPath: ".",
          path: "notes.txt",
          success: true,
          error: null,
          requestId: "req-create",
        },
      },
    ]);
  });

  test("passes entry creation errors through in the response", async () => {
    const cwd = makeDir("workspace-files-create-error-");
    writeFileSync(join(cwd, "notes.txt"), "existing");
    const { subsystem, emitted } = makeSubsystem();

    await subsystem.handleFileEntryCreateRequest({
      type: "fs.entry.create.request",
      cwd,
      parentPath: ".",
      name: "notes.txt",
      kind: "file",
      requestId: "req-create-error",
    });

    expect(emitted).toEqual([
      {
        type: "fs.entry.create.response",
        payload: {
          cwd,
          parentPath: ".",
          path: null,
          success: false,
          error: '"notes.txt" already exists',
          requestId: "req-create-error",
        },
      },
    ]);
  });

  test("renames an entry and emits the resulting path", async () => {
    const cwd = makeDir("workspace-files-rename-");
    writeFileSync(join(cwd, "notes.txt"), "rename me");
    const { subsystem, emitted } = makeSubsystem();

    await subsystem.handleFileEntryRenameRequest({
      type: "fs.entry.rename.request",
      cwd,
      path: "notes.txt",
      name: "renamed.txt",
      requestId: "req-rename",
    });

    expect(existsSync(join(cwd, "notes.txt"))).toBe(false);
    expect(existsSync(join(cwd, "renamed.txt"))).toBe(true);
    expect(emitted).toEqual([
      {
        type: "fs.entry.rename.response",
        payload: {
          cwd,
          path: "notes.txt",
          renamedPath: "renamed.txt",
          success: true,
          error: null,
          requestId: "req-rename",
        },
      },
    ]);
  });

  test("passes entry rename errors through in the response", async () => {
    const cwd = makeDir("workspace-files-rename-error-");
    const { subsystem, emitted } = makeSubsystem();

    await subsystem.handleFileEntryRenameRequest({
      type: "fs.entry.rename.request",
      cwd,
      path: "missing.txt",
      name: "renamed.txt",
      requestId: "req-rename-error",
    });

    expect(emitted).toEqual([
      {
        type: "fs.entry.rename.response",
        payload: {
          cwd,
          path: "missing.txt",
          renamedPath: null,
          success: false,
          error: "File or folder no longer exists",
          requestId: "req-rename-error",
        },
      },
    ]);
  });

  test("duplicates an entry and emits the resulting path", async () => {
    const cwd = makeDir("workspace-files-duplicate-");
    writeFileSync(join(cwd, "notes.txt"), "duplicate me");
    const { subsystem, emitted } = makeSubsystem();

    await subsystem.handleFileEntryDuplicateRequest({
      type: "fs.entry.duplicate.request",
      cwd,
      path: "notes.txt",
      requestId: "req-duplicate",
    });

    expect(readFileSync(join(cwd, "notes copy.txt"), "utf8")).toBe("duplicate me");
    expect(emitted).toEqual([
      {
        type: "fs.entry.duplicate.response",
        payload: {
          cwd,
          path: "notes.txt",
          duplicatedPath: "notes copy.txt",
          success: true,
          error: null,
          requestId: "req-duplicate",
        },
      },
    ]);
  });

  test("passes entry duplication errors through in the response", async () => {
    const cwd = makeDir("workspace-files-duplicate-error-");
    const { subsystem, emitted } = makeSubsystem();

    await subsystem.handleFileEntryDuplicateRequest({
      type: "fs.entry.duplicate.request",
      cwd,
      path: "missing.txt",
      requestId: "req-duplicate-error",
    });

    expect(emitted).toEqual([
      {
        type: "fs.entry.duplicate.response",
        payload: {
          cwd,
          path: "missing.txt",
          duplicatedPath: null,
          success: false,
          error: "File or folder no longer exists",
          requestId: "req-duplicate-error",
        },
      },
    ]);
  });

  test("deletes an entry and emits the complete success response", async () => {
    const cwd = makeDir("workspace-files-delete-");
    writeFileSync(join(cwd, "notes.txt"), "delete me");
    const { subsystem, emitted } = makeSubsystem();

    await subsystem.handleFileEntryDeleteRequest({
      type: "fs.entry.delete.request",
      cwd,
      path: "notes.txt",
      requestId: "req-delete",
    });

    expect(existsSync(join(cwd, "notes.txt"))).toBe(false);
    expect(emitted).toEqual([
      {
        type: "fs.entry.delete.response",
        payload: {
          cwd,
          path: "notes.txt",
          success: true,
          error: null,
          requestId: "req-delete",
        },
      },
    ]);
  });

  test("passes entry deletion errors through in the response", async () => {
    const cwd = makeDir("workspace-files-delete-error-");
    const { subsystem, emitted } = makeSubsystem();

    await subsystem.handleFileEntryDeleteRequest({
      type: "fs.entry.delete.request",
      cwd,
      path: "missing.txt",
      requestId: "req-delete-error",
    });

    expect(emitted).toEqual([
      {
        type: "fs.entry.delete.response",
        payload: {
          cwd,
          path: "missing.txt",
          success: false,
          error: "File or folder no longer exists",
          requestId: "req-delete-error",
        },
      },
    ]);
  });

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

  test("rejects an over-budget file before opening a binary transfer", async () => {
    const cwd = makeDir("workspace-files-read-budget-");
    writeFileSync(join(cwd, "notes.txt"), "hello world");
    const { subsystem, emitted, binary } = makeSubsystem({ hasBinaryChannel: true });

    await subsystem.handleFileExplorerRequest({
      type: "file_explorer_request",
      cwd,
      path: "notes.txt",
      mode: "file",
      requestId: "req-read-budget",
      acceptBinary: true,
      maxBytes: 5,
    });

    expect(binary).toEqual([]);
    expect(emitted).toEqual([
      expect.objectContaining({
        type: "file_explorer_response",
        payload: expect.objectContaining({ error: "File is too large to display" }),
      }),
    ]);
  });

  test("streams a real file larger than the socket limit as paced ordered chunks", async () => {
    const cwd = makeDir("workspace-files-large-binary-");
    const fileBytes = Buffer.alloc(8 * 1024 * 1024 + 123);
    for (let index = 0; index < fileBytes.length; index += 1) {
      fileBytes[index] = index % 251;
    }
    writeFileSync(join(cwd, "large.bin"), fileBytes);

    let releaseFirstChunk: (() => void) | undefined;
    const firstChunkSent = new Promise<void>((resolve) => {
      releaseFirstChunk = resolve;
    });
    let chunkSends = 0;
    const { subsystem, emitted, binary } = makeSubsystem({
      hasBinaryChannel: true,
      emitBinary: async (frame) => {
        if (decodeFileTransferFrame(frame)?.opcode !== FileTransferOpcode.FileChunk) return;
        chunkSends += 1;
        if (chunkSends === 1) await firstChunkSent;
      },
    });

    const transfer = subsystem.handleFileExplorerRequest({
      type: "file_explorer_request",
      cwd,
      path: "large.bin",
      mode: "file",
      requestId: "req-large-binary",
      acceptBinary: true,
    });

    await expect.poll(() => chunkSends).toBe(1);
    expect(binary.map((frame) => decodeFileTransferFrame(frame)?.opcode)).toEqual([
      FileTransferOpcode.FileBegin,
      FileTransferOpcode.FileChunk,
    ]);

    await subsystem.handleFileExplorerRequest({
      type: "file_explorer_request",
      cwd,
      path: ".",
      mode: "list",
      requestId: "req-unrelated-list",
    });
    expect(emitted).toEqual([
      expect.objectContaining({
        type: "file_explorer_response",
        payload: expect.objectContaining({ requestId: "req-unrelated-list", error: null }),
      }),
    ]);

    releaseFirstChunk?.();
    await transfer;

    const frames = binary.map((frame) => decodeFileTransferFrame(frame));
    const chunks = frames.flatMap((frame) =>
      frame?.opcode === FileTransferOpcode.FileChunk ? [frame.payload] : [],
    );
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.byteLength <= 256 * 1024)).toBe(true);
    expect(
      Buffer.compare(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))), fileBytes),
    ).toBe(0);
    expect(frames.at(0)?.opcode).toBe(FileTransferOpcode.FileBegin);
    expect(frames.at(-1)?.opcode).toBe(FileTransferOpcode.FileEnd);
    expect(emitted).toHaveLength(1);
  }, 30_000);

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

describe("entry download over the binary channel", () => {
  function decodeAll(binary: Uint8Array[]): FileTransferFrame[] {
    return binary.map((frame) => {
      const decoded = decodeFileTransferFrame(frame);
      if (!decoded) {
        throw new Error("expected a decodable file-transfer frame");
      }
      return decoded;
    });
  }

  test("answers with metadata, then streams the file as binary frames", async () => {
    const { subsystem, emitted, binary } = makeSubsystem({ hasBinaryChannel: true });
    const cwd = makeDir("workspace-files-dl-");
    writeFileSync(join(cwd, "notes.txt"), "hello world");

    await subsystem.handleEntryDownloadRequest({
      type: "fs.entry.download.request",
      cwd,
      path: "notes.txt",
      requestId: "req-1",
    });

    expect(emitted).toEqual([
      {
        type: "fs.entry.download.response",
        payload: {
          cwd,
          path: "notes.txt",
          kind: "file",
          fileName: "notes.txt",
          mimeType: "text/plain",
          size: 11,
          success: true,
          error: null,
          requestId: "req-1",
        },
      },
    ]);

    const frames = decodeAll(binary);
    expect(frames[0].opcode).toBe(FileTransferOpcode.FileBegin);
    expect(frames.at(-1)?.opcode).toBe(FileTransferOpcode.FileEnd);

    const body = frames
      .filter((frame) => frame.opcode === FileTransferOpcode.FileChunk)
      .map((frame) => new TextDecoder().decode(frame.payload))
      .join("");
    expect(body).toBe("hello world");
  });

  test("preserves a non-ASCII filename byte-for-byte", async () => {
    const { subsystem, emitted } = makeSubsystem({ hasBinaryChannel: true });
    const cwd = makeDir("workspace-files-cjk-");
    const fileName = "設計ノート.md";
    writeFileSync(join(cwd, fileName), "x");

    await subsystem.handleEntryDownloadRequest({
      type: "fs.entry.download.request",
      cwd,
      path: fileName,
      requestId: "req-cjk",
    });

    const response = emitted[0];
    expect(response.type).toBe("fs.entry.download.response");
    if (response.type === "fs.entry.download.response") {
      expect(response.payload.fileName).toBe(fileName);
      expect(response.payload.success).toBe(true);
    }
  });

  test("streams a directory as an archive whose size is not known up front", async () => {
    const { subsystem, emitted, binary } = makeSubsystem({ hasBinaryChannel: true });
    const cwd = makeDir("workspace-files-dir-");
    mkdirSync(join(cwd, "src"));
    writeFileSync(join(cwd, "src", "a.txt"), "alpha");

    await subsystem.handleEntryDownloadRequest({
      type: "fs.entry.download.request",
      cwd,
      path: "src",
      requestId: "req-dir",
    });

    const response = emitted[0];
    expect(response.type).toBe("fs.entry.download.response");
    if (response.type === "fs.entry.download.response") {
      expect(response.payload.kind).toBe("archive");
      expect(response.payload.fileName).toBe("src.zip");
      expect(response.payload.mimeType).toBe("application/zip");
      expect(response.payload.size).toBeNull();
      expect(response.payload.success).toBe(true);
    }

    const frames = decodeAll(binary);
    const begin = frames[0];
    expect(begin.opcode).toBe(FileTransferOpcode.FileBegin);
    if (begin.opcode === FileTransferOpcode.FileBegin) {
      expect(begin.metadata.sizeKnown).toBe(false);
      expect(begin.metadata.fileName).toBe("src.zip");
    }
    expect(frames.at(-1)?.opcode).toBe(FileTransferOpcode.FileEnd);
    expect(frames.some((frame) => frame.opcode === FileTransferOpcode.FileChunk)).toBe(true);
  });

  test("refuses a path that escapes the workspace root", async () => {
    const { subsystem, emitted, binary } = makeSubsystem({ hasBinaryChannel: true });
    const cwd = makeDir("workspace-files-escape-");

    await subsystem.handleEntryDownloadRequest({
      type: "fs.entry.download.request",
      cwd,
      path: "../../etc/passwd",
      requestId: "req-escape",
    });

    expect(binary).toHaveLength(0);
    const response = emitted[0];
    expect(response.type).toBe("fs.entry.download.response");
    if (response.type === "fs.entry.download.response") {
      expect(response.payload.success).toBe(false);
    }
  });

  test("refuses when the connection has no binary channel", async () => {
    const { subsystem, emitted, binary } = makeSubsystem({ hasBinaryChannel: false });
    const cwd = makeDir("workspace-files-nobinary-");
    writeFileSync(join(cwd, "notes.txt"), "hello");

    await subsystem.handleEntryDownloadRequest({
      type: "fs.entry.download.request",
      cwd,
      path: "notes.txt",
      requestId: "req-nobinary",
    });

    expect(binary).toHaveLength(0);
    const response = emitted[0];
    expect(response.type).toBe("fs.entry.download.response");
    if (response.type === "fs.entry.download.response") {
      expect(response.payload.success).toBe(false);
    }
  });

  test("stops sending frames once the client cancels", async () => {
    let cancelled = false;
    const { subsystem, binary } = makeSubsystem({
      hasBinaryChannel: true,
      emitBinary: (frame) => {
        const decoded = decodeFileTransferFrame(frame);
        if (!cancelled && decoded?.opcode === FileTransferOpcode.FileChunk) {
          cancelled = true;
          subsystem.handleFileTransferCancel({
            type: "fs.transfer.cancel",
            requestId: "req-cancel",
          });
        }
      },
    });
    const cwd = makeDir("workspace-files-cancel-");
    // Comfortably more than one 256 KiB chunk, so a cancel lands mid-stream.
    writeFileSync(join(cwd, "big.bin"), Buffer.alloc(1024 * 1024, 7));

    await subsystem.handleEntryDownloadRequest({
      type: "fs.entry.download.request",
      cwd,
      path: "big.bin",
      requestId: "req-cancel",
    });

    const frames = decodeAll(binary);
    expect(frames.some((frame) => frame.opcode === FileTransferOpcode.FileEnd)).toBe(false);
    expect(
      frames.filter((frame) => frame.opcode === FileTransferOpcode.FileChunk).length,
    ).toBeLessThan(4);
  });

  test("dispose cancels an in-flight transfer rather than leaving it parked", async () => {
    const { subsystem, binary } = makeSubsystem({
      hasBinaryChannel: true,
      emitBinary: (frame) => {
        if (decodeFileTransferFrame(frame)?.opcode === FileTransferOpcode.FileChunk) {
          subsystem.dispose();
        }
      },
    });
    const cwd = makeDir("workspace-files-dispose-");
    writeFileSync(join(cwd, "big.bin"), Buffer.alloc(1024 * 1024, 7));

    await subsystem.handleEntryDownloadRequest({
      type: "fs.entry.download.request",
      cwd,
      path: "big.bin",
      requestId: "req-dispose",
    });

    const frames = decodeAll(binary);
    expect(frames.some((frame) => frame.opcode === FileTransferOpcode.FileEnd)).toBe(false);
  });
});

describe("entry upload into the workspace", () => {
  async function feed(
    subsystem: WorkspaceFilesSession,
    requestId: string,
    payloads: string[],
  ): Promise<void> {
    await subsystem.handleFileTransferFrame({
      opcode: FileTransferOpcode.FileBegin,
      requestId,
      metadata: {
        mime: "text/plain",
        size: 0,
        encoding: "binary",
        modifiedAt: "2026-08-25T00:00:00.000Z",
      },
      payload: new Uint8Array(),
    });
    for (const payload of payloads) {
      await subsystem.handleFileTransferFrame({
        opcode: FileTransferOpcode.FileChunk,
        requestId,
        payload: new TextEncoder().encode(payload),
      });
    }
    await subsystem.handleFileTransferFrame({
      opcode: FileTransferOpcode.FileEnd,
      requestId,
      payload: new Uint8Array(),
    });
  }

  test("writes an uploaded file into the workspace and reports where it landed", async () => {
    const { subsystem, emitted } = makeSubsystem({ hasBinaryChannel: true });
    const cwd = makeDir("workspace-upload-");

    await subsystem.handleEntryUploadRequest({
      type: "fs.entry.upload.request",
      cwd,
      path: "notes.txt",
      mimeType: "text/plain",
      size: 11,
      modifiedAt: "2026-08-25T00:00:00.000Z",
      overwrite: "fail",
      requestId: "up-1",
    });
    // No response yet: the path is only known once the bytes land.
    expect(emitted).toHaveLength(0);

    await feed(subsystem, "up-1", ["hello ", "world"]);

    expect(readFileSync(join(cwd, "notes.txt"), "utf8")).toBe("hello world");
    const response = emitted.at(-1);
    expect(response?.type).toBe("fs.entry.upload.response");
    if (response?.type === "fs.entry.upload.response") {
      expect(response.payload.success).toBe(true);
      expect(response.payload.path).toBe("notes.txt");
      expect(response.payload.size).toBe(11);
    }
  });

  test("answers immediately when the target escapes the workspace", async () => {
    const { subsystem, emitted } = makeSubsystem({ hasBinaryChannel: true });
    const cwd = makeDir("workspace-upload-escape-");

    await subsystem.handleEntryUploadRequest({
      type: "fs.entry.upload.request",
      cwd,
      path: "../escaped.txt",
      mimeType: "text/plain",
      size: 1,
      modifiedAt: "2026-08-25T00:00:00.000Z",
      overwrite: "replace",
      requestId: "up-escape",
    });

    const response = emitted[0];
    expect(response?.type).toBe("fs.entry.upload.response");
    if (response?.type === "fs.entry.upload.response") {
      expect(response.payload.success).toBe(false);
      expect(response.payload.path).toBeNull();
      expect(response.payload.error).toMatch(/outside of workspace/i);
    }
  });

  test("renames rather than clobbering when asked", async () => {
    const { subsystem, emitted } = makeSubsystem({ hasBinaryChannel: true });
    const cwd = makeDir("workspace-upload-rename-");
    writeFileSync(join(cwd, "a.txt"), "original");

    await subsystem.handleEntryUploadRequest({
      type: "fs.entry.upload.request",
      cwd,
      path: "a.txt",
      mimeType: "text/plain",
      size: 3,
      modifiedAt: "2026-08-25T00:00:00.000Z",
      overwrite: "rename",
      requestId: "up-rename",
    });
    await feed(subsystem, "up-rename", ["new"]);

    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("original");
    expect(readFileSync(join(cwd, "a (1).txt"), "utf8")).toBe("new");
    const response = emitted.at(-1);
    if (response?.type === "fs.entry.upload.response") {
      expect(response.payload.path).toBe("a (1).txt");
    }
  });

  test("cancelling mid-upload leaves nothing behind", async () => {
    const { subsystem } = makeSubsystem({ hasBinaryChannel: true });
    const cwd = makeDir("workspace-upload-cancel-");

    await subsystem.handleEntryUploadRequest({
      type: "fs.entry.upload.request",
      cwd,
      path: "partial.txt",
      mimeType: "text/plain",
      size: 100,
      modifiedAt: "2026-08-25T00:00:00.000Z",
      overwrite: "fail",
      requestId: "up-cancel",
    });
    await subsystem.handleFileTransferFrame({
      opcode: FileTransferOpcode.FileChunk,
      requestId: "up-cancel",
      payload: new TextEncoder().encode("half"),
    });
    subsystem.handleFileTransferCancel({ type: "fs.transfer.cancel", requestId: "up-cancel" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(existsSync(join(cwd, "partial.txt"))).toBe(false);
    expect(readdirSync(cwd)).toEqual([]);
  });

  test("routes frames for an unknown requestId to the attachment store, not the workspace", async () => {
    const { subsystem } = makeSubsystem({ hasBinaryChannel: true });
    const cwd = makeDir("workspace-upload-router-");

    // No workspace upload registered for this id, so the workspace tree stays untouched.
    await subsystem.handleFileTransferFrame({
      opcode: FileTransferOpcode.FileChunk,
      requestId: "attachment-id",
      payload: new TextEncoder().encode("attachment bytes"),
    });

    expect(readdirSync(cwd)).toEqual([]);
  });
});

describe("upload cleanup when the client socket goes away", () => {
  function leftovers(cwd: string): string[] {
    return readdirSync(cwd).filter((name) => name !== ".git");
  }

  // Observed on a real relay run: the sink opened, the socket dropped before any chunk
  // arrived, and a 0-byte ".<name>.paseo-<uuid>.tmp" stayed in the workspace.
  test("a socket dropping before any chunk leaves no temp file behind", async () => {
    const { subsystem } = makeSubsystem({ hasBinaryChannel: true });
    const cwd = makeDir("workspace-upload-socketloss-");
    const source = {};

    await subsystem.handleEntryUploadRequest(
      {
        type: "fs.entry.upload.request",
        cwd,
        path: "dropped.bin",
        mimeType: "application/octet-stream",
        size: 1024,
        modifiedAt: "2026-08-28T00:00:00.000Z",
        overwrite: "fail",
        requestId: "up-socketloss",
      },
      source,
    );

    expect(leftovers(cwd)).toHaveLength(1);

    subsystem.cancelTransfersForSource(source);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(leftovers(cwd)).toEqual([]);
  });

  // The same drop, but while the sink is still opening: cancellation must still reach it.
  test("a socket dropping while the sink is still opening leaves no temp file behind", async () => {
    const { subsystem } = makeSubsystem({ hasBinaryChannel: true });
    const cwd = makeDir("workspace-upload-socketloss-early-");
    const source = {};

    const pending = subsystem.handleEntryUploadRequest(
      {
        type: "fs.entry.upload.request",
        cwd,
        path: "early.bin",
        mimeType: "application/octet-stream",
        size: 1024,
        modifiedAt: "2026-08-28T00:00:00.000Z",
        overwrite: "fail",
        requestId: "up-socketloss-early",
      },
      source,
    );
    subsystem.cancelTransfersForSource(source);
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(leftovers(cwd)).toEqual([]);
  });
});

describe("an upload that stalls without its socket closing", () => {
  function leftovers(cwd: string): string[] {
    return readdirSync(cwd).filter((name) => name !== ".git");
  }

  async function beginStalledUpload(cwd: string, requestId: string, idleMs: number) {
    const made = makeSubsystem({ hasBinaryChannel: true, uploadIdleTimeoutMs: idleMs });
    await made.subsystem.handleEntryUploadRequest(
      {
        type: "fs.entry.upload.request",
        cwd,
        path: "stalled.bin",
        mimeType: "application/octet-stream",
        size: 4096,
        modifiedAt: "2026-08-28T00:00:00.000Z",
        overwrite: "fail",
        requestId,
      },
      {},
    );
    return made;
  }

  test("the sink is reclaimed and the temp file removed", async () => {
    const cwd = makeDir("workspace-upload-idle-");
    const { subsystem } = await beginStalledUpload(cwd, "up-idle", 40);

    // The sink is open and its temp file is on disk before the deadline passes.
    expect(leftovers(cwd)).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(leftovers(cwd)).toEqual([]);
    void subsystem;
  });

  test("the client is told the upload failed rather than left waiting", async () => {
    const cwd = makeDir("workspace-upload-idle-report-");
    const { emitted } = await beginStalledUpload(cwd, "up-idle-report", 40);

    await new Promise((resolve) => setTimeout(resolve, 200));

    const response = emitted.find(
      (msg) =>
        msg.type === "fs.entry.upload.response" && msg.payload.requestId === "up-idle-report",
    );
    expect(response).toBeDefined();
    if (response?.type === "fs.entry.upload.response") {
      expect(response.payload.success).toBe(false);
      expect(response.payload.path).toBeNull();
      expect(response.payload.error).toMatch(/timed out/i);
    }
  });

  test("a frame restarts the deadline instead of letting a slow upload die", async () => {
    const cwd = makeDir("workspace-upload-idle-progress-");
    const { subsystem } = await beginStalledUpload(cwd, "up-idle-progress", 120);

    // Three gaps, each shorter than the deadline but longer than it in total.
    for (let i = 0; i < 3; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      await subsystem.handleFileTransferFrame({
        opcode: FileTransferOpcode.FileChunk,
        requestId: "up-idle-progress",
        payload: new TextEncoder().encode("still going"),
      });
    }

    await subsystem.handleFileTransferFrame({
      opcode: FileTransferOpcode.FileEnd,
      requestId: "up-idle-progress",
    });

    expect(readFileSync(join(cwd, "stalled.bin"), "utf8")).toBe(
      "still goingstill goingstill going",
    );
  });

  test("a committed upload leaves no timer able to fire later", async () => {
    const cwd = makeDir("workspace-upload-idle-committed-");
    const { subsystem } = await beginStalledUpload(cwd, "up-idle-done", 40);

    await subsystem.handleFileTransferFrame({
      opcode: FileTransferOpcode.FileChunk,
      requestId: "up-idle-done",
      payload: new TextEncoder().encode("done"),
    });
    await subsystem.handleFileTransferFrame({
      opcode: FileTransferOpcode.FileEnd,
      requestId: "up-idle-done",
    });

    await new Promise((resolve) => setTimeout(resolve, 200));

    // The committed file must survive a deadline that has since elapsed.
    expect(readFileSync(join(cwd, "stalled.bin"), "utf8")).toBe("done");
  });
});

describe("upload cancellation racing an in-flight write", () => {
  async function beginUpload(subsystem: WorkspaceFilesSession, cwd: string, requestId: string) {
    await subsystem.handleEntryUploadRequest({
      type: "fs.entry.upload.request",
      cwd,
      path: "racy.bin",
      mimeType: "application/octet-stream",
      size: 1024,
      modifiedAt: "2026-08-26T00:00:00.000Z",
      overwrite: "fail",
      requestId,
    });
  }

  function leftovers(cwd: string): string[] {
    // The sink writes ".<name>.paseo-<uuid>.tmp" beside the target before renaming.
    return readdirSync(cwd).filter((name) => name !== ".git");
  }

  test("a cancel landing mid-write leaves neither the target nor a temp file", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      const { subsystem } = makeSubsystem({ hasBinaryChannel: true });
      const cwd = makeDir("workspace-upload-race-");
      await beginUpload(subsystem, cwd, "up-race");

      // Do not await: the handler is mid-write when the cancel runs.
      const inFlight = subsystem.handleFileTransferFrame({
        opcode: FileTransferOpcode.FileChunk,
        requestId: "up-race",
        payload: new Uint8Array(512 * 1024),
      });
      subsystem.handleFileTransferCancel({ type: "fs.transfer.cancel", requestId: "up-race" });

      await expect(inFlight).resolves.toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(existsSync(join(cwd, "racy.bin"))).toBe(false);
      expect(leftovers(cwd)).toEqual([]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("a cancel landing during commit does not leave a half-written file", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      const { subsystem, emitted } = makeSubsystem({ hasBinaryChannel: true });
      const cwd = makeDir("workspace-upload-commit-race-");
      await beginUpload(subsystem, cwd, "up-commit");

      await subsystem.handleFileTransferFrame({
        opcode: FileTransferOpcode.FileChunk,
        requestId: "up-commit",
        payload: new TextEncoder().encode("partial"),
      });

      // FileEnd commits; cancel arrives while that is still resolving.
      const committing = subsystem.handleFileTransferFrame({
        opcode: FileTransferOpcode.FileEnd,
        requestId: "up-commit",
        payload: new Uint8Array(),
      });
      subsystem.handleFileTransferCancel({ type: "fs.transfer.cancel", requestId: "up-commit" });

      await expect(committing).resolves.toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Either the commit won and the file is whole, or the cancel won and nothing is
      // there. A truncated file, or a temp file left behind, is the failure.
      const names = leftovers(cwd);
      if (names.includes("racy.bin")) {
        expect(readFileSync(join(cwd, "racy.bin"), "utf8")).toBe("partial");
        expect(names).toEqual(["racy.bin"]);
      } else {
        expect(names).toEqual([]);
      }
      expect(unhandled).toEqual([]);
      // A cancelled upload may emit no response at all: the client that cancelled is no
      // longer awaiting one. What must hold is that nothing half-written survives.
      const responses = emitted.filter((message) => message.type === "fs.entry.upload.response");
      expect(responses.length).toBeLessThanOrEqual(1);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("upload frames that arrive before the sink is open", () => {
  test("frames sent straight after the request are applied, not discarded", async () => {
    const { subsystem } = makeSubsystem({ hasBinaryChannel: true });
    const cwd = makeDir("workspace-upload-early-");

    // The client sends the request and its frames back to back, and the daemon dispatches
    // each inbound message independently — so do not await the request first.
    const requestDone = subsystem.handleEntryUploadRequest({
      type: "fs.entry.upload.request",
      cwd,
      path: "raced.txt",
      mimeType: "text/plain",
      size: 5,
      modifiedAt: "2026-08-26T00:00:00.000Z",
      overwrite: "fail",
      requestId: "up-early",
    });

    await subsystem.handleFileTransferFrame({
      opcode: FileTransferOpcode.FileBegin,
      requestId: "up-early",
      metadata: {
        mime: "text/plain",
        size: 5,
        encoding: "binary",
        modifiedAt: "2026-08-26T00:00:00.000Z",
      },
      payload: new Uint8Array(),
    });
    await subsystem.handleFileTransferFrame({
      opcode: FileTransferOpcode.FileChunk,
      requestId: "up-early",
      payload: new TextEncoder().encode("hello"),
    });
    await subsystem.handleFileTransferFrame({
      opcode: FileTransferOpcode.FileEnd,
      requestId: "up-early",
      payload: new Uint8Array(),
    });
    await requestDone;

    expect(readFileSync(join(cwd, "raced.txt"), "utf8")).toBe("hello");
  });

  test("applies chunks in arrival order when frames are not awaited individually", async () => {
    const { subsystem } = makeSubsystem({ hasBinaryChannel: true });
    const cwd = makeDir("workspace-upload-order-");

    const requestDone = subsystem.handleEntryUploadRequest({
      type: "fs.entry.upload.request",
      cwd,
      path: "ordered.txt",
      mimeType: "text/plain",
      size: 6,
      modifiedAt: "2026-08-26T00:00:00.000Z",
      overwrite: "fail",
      requestId: "up-order",
    });

    const frames = [
      subsystem.handleFileTransferFrame({
        opcode: FileTransferOpcode.FileBegin,
        requestId: "up-order",
        metadata: {
          mime: "text/plain",
          size: 6,
          encoding: "binary",
          modifiedAt: "2026-08-26T00:00:00.000Z",
        },
        payload: new Uint8Array(),
      }),
      ...["aa", "bb", "cc"].map((part) =>
        subsystem.handleFileTransferFrame({
          opcode: FileTransferOpcode.FileChunk,
          requestId: "up-order",
          payload: new TextEncoder().encode(part),
        }),
      ),
      subsystem.handleFileTransferFrame({
        opcode: FileTransferOpcode.FileEnd,
        requestId: "up-order",
        payload: new Uint8Array(),
      }),
    ];
    await Promise.all(frames);
    await requestDone;

    expect(readFileSync(join(cwd, "ordered.txt"), "utf8")).toBe("aabbcc");
  });
});

describe("transfers whose socket goes away", () => {
  test("an upload started by a departing socket is aborted and leaves nothing", async () => {
    const { subsystem } = makeSubsystem({ hasBinaryChannel: true });
    const cwd = makeDir("workspace-detach-upload-");
    const socket = { id: "socket-a" };

    await subsystem.handleEntryUploadRequest(
      {
        type: "fs.entry.upload.request",
        cwd,
        path: "orphan.txt",
        mimeType: "text/plain",
        size: 100,
        modifiedAt: "2026-08-26T00:00:00.000Z",
        overwrite: "fail",
        requestId: "detach-1",
      },
      socket,
    );
    await subsystem.handleFileTransferFrame({
      opcode: FileTransferOpcode.FileChunk,
      requestId: "detach-1",
      payload: new TextEncoder().encode("half"),
    });

    subsystem.cancelTransfersForSource(socket);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // No committed file and no temp file left holding the bytes.
    expect(readdirSync(cwd)).toEqual([]);
  });

  test("leaves alone a transfer that another socket started", async () => {
    const { subsystem } = makeSubsystem({ hasBinaryChannel: true });
    const cwd = makeDir("workspace-detach-other-");
    const staying = { id: "socket-staying" };
    const leaving = { id: "socket-leaving" };

    await subsystem.handleEntryUploadRequest(
      {
        type: "fs.entry.upload.request",
        cwd,
        path: "kept.txt",
        mimeType: "text/plain",
        size: 5,
        modifiedAt: "2026-08-26T00:00:00.000Z",
        overwrite: "fail",
        requestId: "detach-2",
      },
      staying,
    );

    subsystem.cancelTransfersForSource(leaving);

    await subsystem.handleFileTransferFrame({
      opcode: FileTransferOpcode.FileChunk,
      requestId: "detach-2",
      payload: new TextEncoder().encode("hello"),
    });
    await subsystem.handleFileTransferFrame({
      opcode: FileTransferOpcode.FileEnd,
      requestId: "detach-2",
      payload: new Uint8Array(),
    });

    expect(readFileSync(join(cwd, "kept.txt"), "utf8")).toBe("hello");
  });
});

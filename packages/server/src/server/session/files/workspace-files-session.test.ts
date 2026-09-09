import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import pino from "pino";
import {
  decodeFileTransferFrame,
  encodeFileTransferFrame,
  FileTransferOpcode,
  type FileTransferFrame,
} from "@getpaseo/protocol/binary-frames/index";
import {
  WorkspaceFilesSession,
  type RemoteFilePolling,
  type WorkspaceFileSystemResolver,
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
    fileSystems?: WorkspaceFileSystemResolver;
    maxFileSubscriptions?: number;
    remoteFilePollIntervalMs?: number;
    remoteFilePolling?: RemoteFilePolling;
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
    fileSystems: options.fileSystems,
    maxFileSubscriptions: options.maxFileSubscriptions,
    remoteFilePollIntervalMs: options.remoteFilePollIntervalMs,
    remoteFilePolling: options.remoteFilePolling,
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
  test("reports status from the matching plugin workspace file system", async () => {
    const cwd = makeDir("workspace-files-plugin-status-");
    const getStatus = vi.fn(async () => ({
      state: "online" as const,
      detail: "Remote workspace is reachable",
    }));
    const { subsystem, emitted } = makeSubsystem({
      fileSystems: {
        resolve: async () => ({
          key: "example.remote",
          writable: false,
          getStatus,
          listDirectory: async () => ({ path: ".", entries: [] }),
          readFile: async () => ({
            path: "remote.txt",
            kind: "text",
            encoding: "utf-8",
            content: "remote",
            size: 6,
            modifiedAt: "2026-09-09T00:00:00.000Z",
          }),
          statFile: async ({ path }) => ({
            status: "ready",
            cwd,
            path,
            size: 6,
            modifiedAt: "2026-09-09T00:00:00.000Z",
          }),
        }),
      },
    });

    await subsystem.handleWorkspaceFileSystemStatusRequest({
      type: "fs.workspace.status.request",
      cwd,
      requestId: "req-status",
    });

    expect(getStatus).toHaveBeenCalledWith({ cwd });
    expect(emitted).toContainEqual({
      type: "fs.workspace.status.response",
      payload: {
        cwd,
        status: { state: "online", detail: "Remote workspace is reachable" },
        error: null,
        requestId: "req-status",
      },
    });
    subsystem.dispose();
  });

  test("routes native directory and file requests through a plugin workspace file system", async () => {
    const cwd = makeDir("workspace-files-plugin-");
    const provider = {
      key: "example.remote",
      writable: true,
      listDirectory: async () => ({
        path: ".",
        entries: [
          {
            name: "remote.txt",
            path: "remote.txt",
            kind: "file" as const,
            size: 12,
            modifiedAt: "2026-09-09T00:00:00.000Z",
          },
        ],
      }),
      readFile: async () => ({
        path: "remote.txt",
        kind: "text" as const,
        encoding: "utf-8" as const,
        content: "remote file\n",
        mimeType: "text/plain",
        size: 12,
        modifiedAt: "2026-09-09T00:00:00.000Z",
        revision: "remote:1",
      }),
      statFile: async () => ({
        status: "ready" as const,
        cwd,
        path: "remote.txt",
        size: 12,
        modifiedAt: "2026-09-09T00:00:00.000Z",
        revision: "remote:1",
      }),
      writeFile: async () => ({
        status: "written" as const,
        modifiedAt: "2026-09-09T00:00:01.000Z",
        size: 13,
        revision: "remote:2",
      }),
    };
    const { subsystem, emitted } = makeSubsystem({
      hasBinaryChannel: true,
      fileSystems: { resolve: async (candidate) => (candidate === cwd ? provider : null) },
    });

    await subsystem.handleFileExplorerRequest({
      type: "file_explorer_request",
      cwd,
      path: ".",
      mode: "list",
      requestId: "req-list",
    });
    await subsystem.handleFileExplorerRequest({
      type: "file_explorer_request",
      cwd,
      path: "remote.txt",
      mode: "file",
      acceptBinary: true,
      requestId: "req-read",
    });

    expect(emitted).toEqual([
      {
        type: "file_explorer_response",
        payload: {
          cwd,
          path: ".",
          mode: "list",
          directory: await provider.listDirectory(),
          file: null,
          error: null,
          requestId: "req-list",
        },
      },
      {
        type: "file_explorer_response",
        payload: {
          cwd,
          path: "remote.txt",
          mode: "file",
          directory: null,
          file: await provider.readFile(),
          error: null,
          requestId: "req-read",
        },
      },
    ]);
    subsystem.dispose();
  });

  test("publishes external changes to subscribed plugin workspace files", async () => {
    const cwd = makeDir("workspace-files-plugin-subscribe-");
    let revision = 1;
    let runPoll = async () => {};
    const clearInterval = vi.fn();
    const remoteFilePolling: RemoteFilePolling = {
      setInterval(callback) {
        runPoll = async () => {
          await callback();
        };
        return { unref: () => undefined } as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval,
    };
    const provider = {
      key: "example.remote",
      writable: true,
      listDirectory: async () => ({ path: ".", entries: [] }),
      readFile: async () => ({
        path: "remote.txt",
        kind: "text" as const,
        encoding: "utf-8" as const,
        content: `version ${revision}`,
        size: 9,
        modifiedAt: `2026-09-09T00:00:0${revision}.000Z`,
        revision: `remote:${revision}`,
      }),
      statFile: async () => ({
        status: "ready" as const,
        cwd,
        path: "remote.txt",
        size: 9,
        modifiedAt: `2026-09-09T00:00:0${revision}.000Z`,
        revision: `remote:${revision}`,
      }),
      writeFile: async () => ({
        status: "written" as const,
        modifiedAt: "2026-09-09T00:00:02.000Z",
        size: 9,
        revision: "remote:2",
      }),
    };
    const { subsystem, emitted } = makeSubsystem({
      fileSystems: { resolve: async (candidate) => (candidate === cwd ? provider : null) },
      remoteFilePollIntervalMs: 5,
      remoteFilePolling,
    });

    await subsystem.handleFileSubscribeRequest({
      type: "fs.file.subscribe.request",
      cwd,
      path: "remote.txt",
      subscriptionId: "sub-remote",
      requestId: "req-subscribe",
    });
    revision = 2;
    await runPoll();

    expect(emitted).toContainEqual({
      type: "fs.file.update",
      payload: {
        subscriptionId: "sub-remote",
        version: {
          status: "ready",
          cwd,
          path: "remote.txt",
          size: 9,
          modifiedAt: "2026-09-09T00:00:02.000Z",
          revision: "remote:2",
        },
      },
    });
    subsystem.dispose();
    expect(clearInterval).toHaveBeenCalledTimes(1);
  });

  test("bounds recurring plugin workspace file subscriptions per session", async () => {
    const cwd = makeDir("workspace-files-plugin-subscription-limit-");
    const statFile = vi.fn(async ({ path }: { path: string }) => ({
      status: "ready" as const,
      cwd,
      path,
      size: 1,
      modifiedAt: "2026-09-09T00:00:00.000Z",
      revision: `remote:${path}`,
    }));
    const setInterval = vi.fn(
      () => ({ unref: () => undefined }) as unknown as ReturnType<typeof globalThis.setInterval>,
    );
    const provider = {
      key: "example.remote",
      writable: false,
      listDirectory: async () => ({ path: ".", entries: [] }),
      readFile: async () => ({
        path: "one.txt",
        kind: "text" as const,
        encoding: "utf-8" as const,
        content: "1",
        size: 1,
        modifiedAt: "2026-09-09T00:00:00.000Z",
        revision: "remote:one.txt",
      }),
      statFile,
    };
    const { subsystem, emitted } = makeSubsystem({
      fileSystems: { resolve: async () => provider },
      maxFileSubscriptions: 1,
      remoteFilePolling: { setInterval, clearInterval: vi.fn() },
    });

    await subsystem.handleFileSubscribeRequest({
      type: "fs.file.subscribe.request",
      cwd,
      path: "one.txt",
      subscriptionId: "sub-one",
      requestId: "req-one",
    });
    await subsystem.handleFileSubscribeRequest({
      type: "fs.file.subscribe.request",
      cwd,
      path: "two.txt",
      subscriptionId: "sub-two",
      requestId: "req-two",
    });

    expect(statFile).toHaveBeenCalledTimes(1);
    expect(setInterval).toHaveBeenCalledTimes(1);
    expect(emitted.at(-1)).toEqual({
      type: "fs.file.subscribe.response",
      payload: {
        subscriptionId: "sub-two",
        initial: {
          status: "error",
          cwd,
          path: "two.txt",
          error: "Too many file subscriptions (maximum 1)",
        },
        requestId: "req-two",
      },
    });
    subsystem.dispose();
  });

  test("routes native file subscriptions and writes through a plugin workspace file system", async () => {
    const cwd = makeDir("workspace-files-plugin-write-");
    const writes: unknown[] = [];
    const provider = {
      key: "example.remote",
      writable: true,
      listDirectory: async () => ({ path: ".", entries: [] }),
      readFile: async () => ({
        path: "remote.txt",
        kind: "text" as const,
        encoding: "utf-8" as const,
        content: "before",
        size: 6,
        modifiedAt: "2026-09-09T00:00:00.000Z",
        revision: "remote:1",
      }),
      statFile: async () => ({
        status: "ready" as const,
        cwd,
        path: "remote.txt",
        size: 6,
        modifiedAt: "2026-09-09T00:00:00.000Z",
        revision: "remote:1",
      }),
      writeFile: async (input: unknown) => {
        writes.push(input);
        return {
          status: "written" as const,
          modifiedAt: "2026-09-09T00:00:01.000Z",
          size: 5,
          revision: "remote:2",
        };
      },
    };
    const { subsystem, emitted } = makeSubsystem({
      fileSystems: { resolve: async (candidate) => (candidate === cwd ? provider : null) },
    });

    await subsystem.handleFileSubscribeRequest({
      type: "fs.file.subscribe.request",
      cwd,
      path: "remote.txt",
      subscriptionId: "sub-remote",
      requestId: "req-subscribe",
    });
    await subsystem.handleFileWriteRequest({
      type: "fs.file.write.request",
      cwd,
      path: "remote.txt",
      content: "after",
      expectedModifiedAt: "2026-09-09T00:00:00.000Z",
      expectedRevision: "remote:1",
      requestId: "req-write",
    });

    expect(writes).toEqual([
      {
        cwd,
        path: "remote.txt",
        content: "after",
        expectedModifiedAt: "2026-09-09T00:00:00.000Z",
        expectedRevision: "remote:1",
      },
    ]);
    expect(emitted).toEqual([
      {
        type: "fs.file.subscribe.response",
        payload: {
          subscriptionId: "sub-remote",
          initial: await provider.statFile(),
          requestId: "req-subscribe",
        },
      },
      {
        type: "fs.file.write.response",
        payload: {
          result: {
            status: "written",
            modifiedAt: "2026-09-09T00:00:01.000Z",
            size: 5,
            revision: "remote:2",
          },
          requestId: "req-write",
        },
      },
    ]);
    subsystem.dispose();
  });

  test("does not fall back to the local anchor for unsupported remote entry mutations", async () => {
    const cwd = makeDir("workspace-files-plugin-guard-");
    const provider = {
      key: "example.remote",
      writable: true,
      listDirectory: async () => ({ path: ".", entries: [] }),
      readFile: async () => ({
        path: "remote.txt",
        kind: "text" as const,
        encoding: "utf-8" as const,
        content: "remote",
        size: 6,
        modifiedAt: "2026-09-09T00:00:00.000Z",
        revision: "remote:1",
      }),
      statFile: async () => ({
        status: "ready" as const,
        cwd,
        path: "remote.txt",
        size: 6,
        modifiedAt: "2026-09-09T00:00:00.000Z",
        revision: "remote:1",
      }),
      writeFile: async () => ({
        status: "written" as const,
        modifiedAt: "2026-09-09T00:00:01.000Z",
        size: 6,
        revision: "remote:2",
      }),
    };
    const { subsystem, emitted } = makeSubsystem({
      fileSystems: { resolve: async () => provider },
    });

    await subsystem.handleFileEntryCreateRequest({
      type: "fs.entry.create.request",
      cwd,
      parentPath: ".",
      name: "must-not-be-local.txt",
      kind: "file",
      requestId: "req-create-remote",
    });

    expect(existsSync(join(cwd, "must-not-be-local.txt"))).toBe(false);
    expect(emitted).toEqual([
      {
        type: "fs.entry.create.response",
        payload: {
          cwd,
          parentPath: ".",
          path: null,
          success: false,
          error: "Workspace file system example.remote does not support creating entries",
          requestId: "req-create-remote",
        },
      },
    ]);
  });

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

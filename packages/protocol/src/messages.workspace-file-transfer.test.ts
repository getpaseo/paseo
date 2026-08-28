import { describe, expect, test } from "vitest";
import { FileBeginMetadataSchema } from "./binary-frames/file-transfer.js";
import {
  FileEntryDownloadRequestSchema,
  FileEntryDownloadResponseSchema,
  FileEntryUploadRequestSchema,
  FileEntryUploadResponseSchema,
  FileTransferAckSchema,
  FileTransferCancelSchema,
  ServerInfoStatusPayloadSchema,
} from "./messages.js";

describe("workspace file transfer messages", () => {
  test("gates the feature and stays absent for a daemon that predates it", () => {
    const legacy = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "server-1",
      features: {},
    });
    expect(legacy.features?.workspaceFileTransfer).toBeUndefined();

    const current = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "server-1",
      features: { workspaceFileTransfer: true },
    });
    expect(current.features?.workspaceFileTransfer).toBe(true);
  });

  test("round-trips a file download request and response", () => {
    const request = {
      type: "fs.entry.download.request" as const,
      cwd: "/repo",
      path: "src/main.ts",
      requestId: "req_1",
    };
    expect(FileEntryDownloadRequestSchema.parse(request)).toEqual(request);

    const response = {
      type: "fs.entry.download.response" as const,
      payload: {
        cwd: "/repo",
        path: "src/main.ts",
        kind: "file" as const,
        fileName: "main.ts",
        mimeType: "text/plain",
        size: 2048,
        success: true,
        error: null,
        requestId: "req_1",
      },
    };
    expect(FileEntryDownloadResponseSchema.parse(response)).toEqual(response);
  });

  test("carries a null size for a directory archive, whose length is unknown up front", () => {
    const response = {
      type: "fs.entry.download.response" as const,
      payload: {
        cwd: "/repo",
        path: "src",
        kind: "archive" as const,
        fileName: "src.zip",
        mimeType: "application/zip",
        size: null,
        success: true,
        error: null,
        requestId: "req_2",
      },
    };
    expect(FileEntryDownloadResponseSchema.parse(response)).toEqual(response);
  });

  test("preserves a non-ASCII filename byte-for-byte in both directions", () => {
    const fileName = "設計ノート 🗂.md";
    const response = FileEntryDownloadResponseSchema.parse({
      type: "fs.entry.download.response",
      payload: {
        cwd: "/repo",
        path: `docs/${fileName}`,
        kind: "file",
        fileName,
        mimeType: "text/markdown",
        size: 12,
        success: true,
        error: null,
        requestId: "req_3",
      },
    });
    expect(response.payload.fileName).toBe(fileName);

    const request = FileEntryUploadRequestSchema.parse({
      type: "fs.entry.upload.request",
      cwd: "/repo",
      path: `docs/${fileName}`,
      mimeType: "text/markdown",
      size: 12,
      modifiedAt: "2026-08-25T00:00:00.000Z",
      overwrite: "fail",
      requestId: "req_3",
    });
    expect(request.path).toBe(`docs/${fileName}`);
  });

  test("round-trips an upload request and response", () => {
    const request = {
      type: "fs.entry.upload.request" as const,
      cwd: "/repo",
      path: "assets/logo.png",
      mimeType: "image/png",
      size: 4096,
      modifiedAt: "2026-08-25T00:00:00.000Z",
      overwrite: "replace" as const,
      requestId: "req_4",
    };
    expect(FileEntryUploadRequestSchema.parse(request)).toEqual(request);

    const response = {
      type: "fs.entry.upload.response" as const,
      payload: {
        cwd: "/repo",
        path: "assets/logo.png",
        size: 4096,
        modifiedAt: "2026-08-25T00:00:00.000Z",
        success: true,
        error: null,
        requestId: "req_4",
      },
    };
    expect(FileEntryUploadResponseSchema.parse(response)).toEqual(response);
  });

  test("rejects an overwrite mode outside the agreed set", () => {
    expect(
      FileEntryUploadRequestSchema.safeParse({
        type: "fs.entry.upload.request",
        cwd: "/repo",
        path: "a.txt",
        mimeType: "text/plain",
        size: 1,
        modifiedAt: "2026-08-25T00:00:00.000Z",
        overwrite: "clobber",
        requestId: "req_5",
      }).success,
    ).toBe(false);
  });

  test("round-trips ack and cancel, which travel in both directions", () => {
    const ack = { type: "fs.transfer.ack" as const, requestId: "req_6", bytesReceived: 2097152 };
    expect(FileTransferAckSchema.parse(ack)).toEqual(ack);

    const cancel = { type: "fs.transfer.cancel" as const, requestId: "req_6" };
    expect(FileTransferCancelSchema.parse(cancel)).toEqual(cancel);
  });

  test("treats an absent sizeKnown as a known size, so old senders keep their meaning", () => {
    const legacy = FileBeginMetadataSchema.parse({
      mime: "text/plain",
      size: 10,
      encoding: "utf-8",
      modifiedAt: "2026-08-25T00:00:00.000Z",
    });
    expect(legacy.sizeKnown).toBeUndefined();

    const streamed = FileBeginMetadataSchema.parse({
      mime: "application/zip",
      size: 0,
      encoding: "binary",
      modifiedAt: "2026-08-25T00:00:00.000Z",
      sizeKnown: false,
    });
    expect(streamed.sizeKnown).toBe(false);
  });
});

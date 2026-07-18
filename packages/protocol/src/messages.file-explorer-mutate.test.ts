import { describe, expect, test } from "vitest";

import {
  FileExplorerCreateRequestSchema,
  FileExplorerCreateResponseSchema,
  FileExplorerDeleteRequestSchema,
  FileExplorerDeleteResponseSchema,
  FileExplorerDuplicateRequestSchema,
  FileExplorerDuplicateResponseSchema,
  FileExplorerRenameRequestSchema,
  FileExplorerRenameResponseSchema,
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";

const sampleEntry = {
  name: "notes.txt",
  path: "src/notes.txt",
  kind: "file" as const,
  size: 12,
  modifiedAt: "2026-07-18T12:00:00.000Z",
};

describe("file.explorer mutate schemas", () => {
  test("parses a valid create request", () => {
    expect(
      FileExplorerCreateRequestSchema.parse({
        type: "file.explorer.create.request",
        cwd: "/tmp/project",
        parentPath: "src",
        name: "notes.txt",
        kind: "file",
        requestId: "req-create",
      }),
    ).toEqual({
      type: "file.explorer.create.request",
      cwd: "/tmp/project",
      parentPath: "src",
      name: "notes.txt",
      kind: "file",
      requestId: "req-create",
    });
  });

  test("parses a valid create response", () => {
    const payload = {
      cwd: "/tmp/project",
      entry: sampleEntry,
      error: null,
      requestId: "req-create",
    };

    expect(
      FileExplorerCreateResponseSchema.parse({
        type: "file.explorer.create.response",
        payload,
      }).payload,
    ).toEqual(payload);
  });

  test("parses rename/delete/duplicate request and response shapes", () => {
    expect(
      FileExplorerRenameRequestSchema.parse({
        type: "file.explorer.rename.request",
        cwd: "/tmp/project",
        path: "src/notes.txt",
        newName: "readme.txt",
        requestId: "req-rename",
      }),
    ).toMatchObject({ type: "file.explorer.rename.request" });

    expect(
      FileExplorerRenameResponseSchema.parse({
        type: "file.explorer.rename.response",
        payload: {
          cwd: "/tmp/project",
          entry: { ...sampleEntry, name: "readme.txt", path: "src/readme.txt" },
          error: null,
          requestId: "req-rename",
        },
      }),
    ).toMatchObject({ type: "file.explorer.rename.response" });

    expect(
      FileExplorerDeleteRequestSchema.parse({
        type: "file.explorer.delete.request",
        cwd: "/tmp/project",
        path: "src/notes.txt",
        requestId: "req-delete",
      }),
    ).toMatchObject({ type: "file.explorer.delete.request" });

    expect(
      FileExplorerDeleteResponseSchema.parse({
        type: "file.explorer.delete.response",
        payload: {
          cwd: "/tmp/project",
          path: "src/notes.txt",
          success: true,
          error: null,
          requestId: "req-delete",
        },
      }),
    ).toMatchObject({ type: "file.explorer.delete.response" });

    expect(
      FileExplorerDuplicateRequestSchema.parse({
        type: "file.explorer.duplicate.request",
        cwd: "/tmp/project",
        path: "src/notes.txt",
        requestId: "req-duplicate",
      }),
    ).toMatchObject({ type: "file.explorer.duplicate.request" });

    expect(
      FileExplorerDuplicateResponseSchema.parse({
        type: "file.explorer.duplicate.response",
        payload: {
          cwd: "/tmp/project",
          entry: {
            ...sampleEntry,
            name: "notes copy.txt",
            path: "src/notes copy.txt",
          },
          error: null,
          requestId: "req-duplicate",
        },
      }),
    ).toMatchObject({ type: "file.explorer.duplicate.response" });
  });

  test("parses requests through the inbound message union", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "file.explorer.create.request",
        cwd: "/tmp/project",
        parentPath: ".",
        name: "folder",
        kind: "directory",
        requestId: "req-create-dir",
      }),
    ).toMatchObject({ type: "file.explorer.create.request" });

    expect(
      SessionInboundMessageSchema.parse({
        type: "file.explorer.rename.request",
        cwd: "/tmp/project",
        path: "a.txt",
        newName: "b.txt",
        requestId: "req-rename",
      }),
    ).toMatchObject({ type: "file.explorer.rename.request" });

    expect(
      SessionInboundMessageSchema.parse({
        type: "file.explorer.delete.request",
        cwd: "/tmp/project",
        path: "a.txt",
        requestId: "req-delete",
      }),
    ).toMatchObject({ type: "file.explorer.delete.request" });

    expect(
      SessionInboundMessageSchema.parse({
        type: "file.explorer.duplicate.request",
        cwd: "/tmp/project",
        path: "a.txt",
        requestId: "req-duplicate",
      }),
    ).toMatchObject({ type: "file.explorer.duplicate.request" });
  });

  test("parses responses through the outbound message union", () => {
    expect(
      SessionOutboundMessageSchema.parse({
        type: "file.explorer.create.response",
        payload: {
          cwd: "/tmp/project",
          entry: null,
          error: "Already exists",
          requestId: "req-create",
        },
      }),
    ).toMatchObject({ type: "file.explorer.create.response" });

    expect(
      SessionOutboundMessageSchema.parse({
        type: "file.explorer.delete.response",
        payload: {
          cwd: "/tmp/project",
          path: "a.txt",
          success: false,
          error: "Not found",
          requestId: "req-delete",
        },
      }),
    ).toMatchObject({ type: "file.explorer.delete.response" });
  });

  test("accepts the fileExplorerMutate server_info feature flag", () => {
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "srv_test",
        features: {
          fileExplorerMutate: true,
        },
      }).features,
    ).toEqual({ fileExplorerMutate: true });
  });

  test("still parses server_info without the fileExplorerMutate feature flag", () => {
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "srv_test",
        features: {
          providersSnapshot: true,
        },
      }).features,
    ).toEqual({ providersSnapshot: true });
  });
});

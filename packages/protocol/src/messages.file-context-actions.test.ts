import { describe, expect, test } from "vitest";
import {
  CheckoutDiscardChangesRequestSchema,
  CheckoutDiscardChangesResponseSchema,
  FileEntryCreateRequestSchema,
  FileEntryCreateResponseSchema,
  FileEntryDeleteRequestSchema,
  FileEntryDeleteResponseSchema,
  FileEntryDuplicateRequestSchema,
  FileEntryDuplicateResponseSchema,
  FileEntryRenameRequestSchema,
  FileEntryRenameResponseSchema,
  ServerInfoStatusPayloadSchema,
} from "./messages.js";

describe("file context action messages", () => {
  test("keeps context-action capabilities optional and preserves advertised support", () => {
    const legacy = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "server-1",
      features: {},
    });
    expect(legacy.features?.fsEntryOps).toBeUndefined();
    expect(legacy.features?.fsEntryDuplicate).toBeUndefined();
    expect(legacy.features?.checkoutDiscardChanges).toBeUndefined();

    const current = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "server-1",
      features: {
        fsEntryOps: true,
        fsEntryDuplicate: true,
        checkoutDiscardChanges: true,
      },
    });
    expect(current.features).toMatchObject({
      fsEntryOps: true,
      fsEntryDuplicate: true,
      checkoutDiscardChanges: true,
    });
  });

  test("rejects discard requests without a path", () => {
    expect(() =>
      CheckoutDiscardChangesRequestSchema.parse({
        type: "checkout.discard_changes.request",
        cwd: "/workspace",
        paths: [],
        requestId: "discard-empty",
      }),
    ).toThrow();
  });

  test("round-trips file entry create requests and responses", () => {
    const request = {
      type: "fs.entry.create.request",
      cwd: "/workspace",
      parentPath: "src/components",
      name: "button.tsx",
      kind: "file",
      requestId: "create-1",
    };
    expect(FileEntryCreateRequestSchema.parse(request)).toEqual(request);

    const response = {
      type: "fs.entry.create.response",
      payload: {
        cwd: "/workspace",
        parentPath: "src/components",
        path: "src/components/button.tsx",
        success: true,
        error: null,
        requestId: "create-1",
      },
    };
    expect(FileEntryCreateResponseSchema.parse(response)).toEqual(response);
  });

  test("round-trips file entry rename requests and responses", () => {
    const request = {
      type: "fs.entry.rename.request",
      cwd: "/workspace",
      path: "src/old.ts",
      name: "new.ts",
      requestId: "rename-1",
    };
    expect(FileEntryRenameRequestSchema.parse(request)).toEqual(request);

    const response = {
      type: "fs.entry.rename.response",
      payload: {
        cwd: "/workspace",
        path: "src/old.ts",
        renamedPath: "src/new.ts",
        success: true,
        error: null,
        requestId: "rename-1",
      },
    };
    expect(FileEntryRenameResponseSchema.parse(response)).toEqual(response);
  });

  test("round-trips file entry duplicate requests and responses", () => {
    const request = {
      type: "fs.entry.duplicate.request",
      cwd: "/workspace",
      path: "src/button.tsx",
      requestId: "duplicate-1",
    };
    expect(FileEntryDuplicateRequestSchema.parse(request)).toEqual(request);

    const response = {
      type: "fs.entry.duplicate.response",
      payload: {
        cwd: "/workspace",
        path: "src/button.tsx",
        duplicatedPath: "src/button copy.tsx",
        success: true,
        error: null,
        requestId: "duplicate-1",
      },
    };
    expect(FileEntryDuplicateResponseSchema.parse(response)).toEqual(response);
  });

  test("round-trips file entry delete requests and responses", () => {
    const request = {
      type: "fs.entry.delete.request",
      cwd: "/workspace",
      path: "src/old.ts",
      requestId: "delete-1",
    };
    expect(FileEntryDeleteRequestSchema.parse(request)).toEqual(request);

    const response = {
      type: "fs.entry.delete.response",
      payload: {
        cwd: "/workspace",
        path: "src/old.ts",
        success: false,
        error: "File or folder no longer exists",
        requestId: "delete-1",
      },
    };
    expect(FileEntryDeleteResponseSchema.parse(response)).toEqual(response);
  });

  test("round-trips checkout discard requests and responses", () => {
    const request = {
      type: "checkout.discard_changes.request",
      cwd: "/workspace",
      paths: ["src", "README.md"],
      requestId: "discard-1",
    };
    expect(CheckoutDiscardChangesRequestSchema.parse(request)).toEqual(request);

    const response = {
      type: "checkout.discard_changes.response",
      payload: {
        cwd: "/workspace",
        success: false,
        error: { code: "UNKNOWN", message: "discard failed" },
        requestId: "discard-1",
      },
    };
    expect(CheckoutDiscardChangesResponseSchema.parse(response)).toEqual(response);
  });
});

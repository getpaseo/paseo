// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileReadResult } from "@getpaseo/client/internal/daemon-client";
import { __setAttachmentStoreForTests } from "@/attachments/store";
import type { AttachmentStore } from "@/attachments/types";
import { useDaemonUploadedImage } from "./use-daemon-uploaded-image";

function createMemoryStore(): AttachmentStore {
  const bytesById = new Map<string, Uint8Array>();
  return {
    storageType: "web-indexeddb",
    async save(input) {
      const id = input.id ?? "saved";
      const bytes = input.source.kind === "bytes" ? input.source.bytes : new Uint8Array();
      bytesById.set(id, bytes);
      return {
        id,
        mimeType: input.mimeType ?? "image/png",
        storageType: "web-indexeddb",
        storageKey: id,
        fileName: input.fileName ?? null,
        byteSize: bytes.byteLength,
        createdAt: 1,
      };
    },
    async encodeBase64() {
      return "";
    },
    async readBytes({ attachment }) {
      return bytesById.get(attachment.id) ?? new Uint8Array();
    },
    async resolvePreviewUrl({ attachment }) {
      return `blob:${attachment.id}`;
    },
    async delete() {},
    async garbageCollect() {},
  };
}

describe("useDaemonUploadedImage", () => {
  beforeEach(() => {
    __setAttachmentStoreForTests(createMemoryStore());
  });

  afterEach(() => {
    cleanup();
    __setAttachmentStoreForTests(null);
  });

  it("loads an uploaded image from the daemon via readFile and persists local AttachmentMetadata", async () => {
    const readFile = vi.fn(
      async (cwd: string, path: string): Promise<FileReadResult> => ({
        kind: "image",
        path,
        mime: "image/jpeg",
        size: 4,
        modifiedAt: "2026-11-28T00:00:00.000Z",
        bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      }),
    );

    const { result } = renderHook(() =>
      useDaemonUploadedImage({
        image: {
          storageType: "daemon-upload",
          id: "upload_reload_1",
          fileName: "photo.jpg",
          mimeType: "image/jpeg",
          size: 4,
          path: "/home/user/.paseo/uploads/upload_reload_1/photo.jpg",
        },
        client: { readFile },
        serverId: "srv-1",
      }),
    );

    await waitFor(() => {
      expect(result.current).not.toBeNull();
    });
    expect(readFile).toHaveBeenCalledWith(
      "/",
      "/home/user/.paseo/uploads/upload_reload_1/photo.jpg",
    );
    expect(result.current).toMatchObject({
      mimeType: "image/jpeg",
      fileName: "photo.jpg",
      byteSize: 4,
      storageType: "web-indexeddb",
    });
  });
});

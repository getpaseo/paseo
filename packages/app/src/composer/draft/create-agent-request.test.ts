import { afterEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AttachmentMetadata, AttachmentStore } from "@/attachments/types";
import { __setAttachmentStoreForTests } from "@/attachments/store";
import { requestWorkspaceDraftAgent } from "./create-agent-request";

function createFakeStore(bytesById: Record<string, Uint8Array>): AttachmentStore {
  return {
    storageType: "web-indexeddb",
    async save() {
      throw new Error("not used");
    },
    async encodeBase64() {
      throw new Error("encodeBase64 must not be called when uploading images");
    },
    async readBytes({ attachment }) {
      const bytes = bytesById[attachment.id];
      if (!bytes) throw new Error(`missing ${attachment.id}`);
      return bytes;
    },
    async resolvePreviewUrl() {
      return "blob:test";
    },
    async delete() {},
    async garbageCollect() {},
  };
}

describe("requestWorkspaceDraftAgent", () => {
  afterEach(() => {
    __setAttachmentStoreForTests(null);
  });

  it("uploads draft images sequentially via uploadFile and sends them in attachments with role='image' instead of inline base64", async () => {
    const firstBytes = new Uint8Array([1, 2, 3, 4]);
    const secondBytes = new Uint8Array([5, 6, 7]);
    __setAttachmentStoreForTests(createFakeStore({ img1: firstBytes, img2: secondBytes }));

    const uploadFile = vi.fn(
      async (input: { fileName: string; mimeType: string; bytes: Uint8Array }) => ({
        requestId: `req-${input.fileName}`,
        file: {
          type: "uploaded_file" as const,
          id: `upload_${input.fileName}`,
          fileName: input.fileName,
          mimeType: input.mimeType,
          size: input.bytes.byteLength,
          path: `/home/user/.paseo/uploads/upload_${input.fileName}/${input.fileName}`,
        },
        error: null,
      }),
    );
    const createAgent = vi.fn(async (input: Record<string, unknown>) => ({
      id: "agent-new",
      ...input,
    }));
    const client = { uploadFile, createAgent } as unknown as DaemonClient;

    const images: AttachmentMetadata[] = [
      {
        id: "img1",
        mimeType: "image/jpeg",
        storageType: "web-indexeddb",
        storageKey: "img1",
        fileName: "first.jpg",
        byteSize: firstBytes.byteLength,
        createdAt: 1,
      },
      {
        id: "img2",
        mimeType: "image/png",
        storageType: "web-indexeddb",
        storageKey: "img2",
        fileName: "second.png",
        byteSize: secondBytes.byteLength,
        createdAt: 2,
      },
    ];

    await requestWorkspaceDraftAgent(client, {
      workspaceId: "ws-1",
      config: { provider: "claude", cwd: "/repo" },
      text: "Look at these two photos",
      clientMessageId: "draft:initial-message",
      images,
    });

    expect(uploadFile).toHaveBeenCalledTimes(2);
    expect(createAgent).toHaveBeenCalledTimes(1);
    const createCall = createAgent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(createCall.images).toBeUndefined();
    expect(createCall.attachments).toEqual([
      {
        type: "uploaded_file",
        id: "upload_first.jpg",
        fileName: "first.jpg",
        mimeType: "image/jpeg",
        size: 4,
        path: "/home/user/.paseo/uploads/upload_first.jpg/first.jpg",
        role: "image",
      },
      {
        type: "uploaded_file",
        id: "upload_second.png",
        fileName: "second.png",
        mimeType: "image/png",
        size: 3,
        path: "/home/user/.paseo/uploads/upload_second.png/second.png",
        role: "image",
      },
    ]);
  });
});

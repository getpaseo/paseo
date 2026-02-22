import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { mergePendingCreateImages } from "./pending-create-images";

function userMessage(params: {
  id: string;
  text: string;
  images?: Array<{ id: string; storageType: "native-file"; storageKey: string; mimeType: string; createdAt: number }>;
}): StreamItem {
  return {
    kind: "user_message",
    id: params.id,
    text: params.text,
    timestamp: new Date("2026-01-01T00:00:00Z"),
    ...(params.images ? { images: params.images } : {}),
  };
}

function buildImage(id: string) {
  return [
    {
      id,
      storageType: "native-file" as const,
      storageKey: `/tmp/${id}.jpg`,
      mimeType: "image/jpeg",
      createdAt: Date.now(),
    },
  ];
}

describe("mergePendingCreateImages", () => {
  it("returns same reference when pending images are absent", () => {
    const streamItems = [userMessage({ id: "msg-1", text: "hello" })];
    const result = mergePendingCreateImages({
      streamItems,
      clientMessageId: "msg-1",
      images: [],
    });
    expect(result).toBe(streamItems);
  });

  it("merges images by clientMessageId when matched message has none", () => {
    const streamItems = [userMessage({ id: "msg-1", text: "hello" })];
    const images = buildImage("image-1");
    const result = mergePendingCreateImages({
      streamItems,
      clientMessageId: "msg-1",
      images,
    });

    expect(result).not.toBe(streamItems);
    const updated = result[0];
    expect(updated?.kind).toBe("user_message");
    if (updated?.kind !== "user_message") {
      throw new Error("Expected user_message item");
    }
    expect(updated.images).toEqual(images);
  });

  it("does not merge when clientMessageId does not match", () => {
    const streamItems = [userMessage({ id: "msg-1", text: "same text" })];
    const images = buildImage("image-2");
    const result = mergePendingCreateImages({
      streamItems,
      clientMessageId: "missing-id",
      images,
    });

    expect(result).toBe(streamItems);
  });

  it("does not overwrite existing user message images", () => {
    const existingImages = buildImage("existing");
    const streamItems = [
      userMessage({ id: "msg-1", text: "hello", images: existingImages }),
    ];
    const result = mergePendingCreateImages({
      streamItems,
      clientMessageId: "msg-1",
      images: buildImage("new"),
    });

    expect(result).toBe(streamItems);
    const unchanged = result[0];
    expect(unchanged?.kind).toBe("user_message");
    if (unchanged?.kind !== "user_message") {
      throw new Error("Expected user_message item");
    }
    expect(unchanged.images).toEqual(existingImages);
  });
});

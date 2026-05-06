import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { mergePendingCreateImages } from "./pending-create-images";
import type { AgentAttachment } from "@server/shared/messages";

function userMessage(params: {
  id: string;
  text: string;
  images?: Array<{
    id: string;
    storageType: "native-file";
    storageKey: string;
    mimeType: string;
    createdAt: number;
  }>;
  attachments?: AgentAttachment[];
}): StreamItem {
  return {
    kind: "user_message",
    id: params.id,
    text: params.text,
    timestamp: new Date("2026-01-01T00:00:00Z"),
    ...(params.images ? { images: params.images } : {}),
    ...(params.attachments ? { attachments: params.attachments } : {}),
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

function buildReviewAttachment(): AgentAttachment {
  return {
    type: "review",
    mimeType: "application/paseo-review",
    cwd: "/repo",
    mode: "base",
    comments: [],
  };
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

  it("merges attachments by clientMessageId when matched message has none", () => {
    const streamItems = [userMessage({ id: "msg-1", text: "hello" })];
    const attachments = [buildReviewAttachment()];
    const result = mergePendingCreateImages({
      streamItems,
      clientMessageId: "msg-1",
      attachments,
    });

    expect(result).not.toBe(streamItems);
    const updated = result[0];
    expect(updated?.kind).toBe("user_message");
    if (updated?.kind !== "user_message") {
      throw new Error("Expected user_message item");
    }
    expect(updated.attachments).toEqual(attachments);
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
    const streamItems = [userMessage({ id: "msg-1", text: "hello", images: existingImages })];
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

  it("does not overwrite existing user message attachments", () => {
    const existingAttachments = [buildReviewAttachment()];
    const streamItems = [
      userMessage({ id: "msg-1", text: "hello", attachments: existingAttachments }),
    ];
    const result = mergePendingCreateImages({
      streamItems,
      clientMessageId: "msg-1",
      attachments: [
        {
          type: "github_issue",
          mimeType: "application/github-issue",
          number: 7,
          title: "Issue",
          url: "https://github.com/getpaseo/paseo/issues/7",
        },
      ],
    });

    expect(result).toBe(streamItems);
    const unchanged = result[0];
    expect(unchanged?.kind).toBe("user_message");
    if (unchanged?.kind !== "user_message") {
      throw new Error("Expected user_message item");
    }
    expect(unchanged.attachments).toEqual(existingAttachments);
  });
});

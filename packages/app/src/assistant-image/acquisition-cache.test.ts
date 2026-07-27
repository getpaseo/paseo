import { describe, expect, it } from "vitest";
import {
  collectRetainedAttachmentIds,
  retainAttachmentForGarbageCollection,
} from "@/attachments/gc-retention";
import {
  createAssistantImageAcquisitionCache,
  createAssistantImageFileAcquisitionKey,
  createAssistantImageFilePreviewAttachmentId,
  createAssistantImageOccurrenceKey,
} from "./acquisition-cache";

describe("assistant image acquisition cache", () => {
  it("evicts a rejected acquisition so the next request can retry", async () => {
    const cache = createAssistantImageAcquisitionCache<string>({ capacity: 2 });
    let attempts = 0;

    await expect(
      cache.acquire("image", async () => {
        attempts += 1;
        throw new Error("first attempt failed");
      }),
    ).rejects.toThrow("first attempt failed");
    const recovered = await cache.acquire("image", async () => {
      attempts += 1;
      return "recovered";
    });

    expect({ attempts, recovered, size: cache.size() }).toEqual({
      attempts: 2,
      recovered: "recovered",
      size: 1,
    });
  });

  it("bounds successful acquisitions and evicts the least recently used entry", async () => {
    const cache = createAssistantImageAcquisitionCache<string>({ capacity: 2 });
    const located: string[] = [];
    const locate = async (key: string) => {
      located.push(key);
      return key;
    };

    await cache.acquire("a", async () => await locate("a"));
    await cache.acquire("b", async () => await locate("b"));
    await cache.acquire("a", async () => await locate("a-again"));
    await cache.acquire("c", async () => await locate("c"));
    await cache.acquire("b", async () => await locate("b-again"));

    expect({ located, size: cache.size() }).toEqual({
      located: ["a", "b", "c", "b-again"],
      size: 2,
    });
  });

  it("reuses an acquired image when the current locator is unavailable", async () => {
    const cache = createAssistantImageAcquisitionCache<string>({ capacity: 2 });
    let unavailableCalls = 0;

    await cache.acquire("message:image", async () => "persisted attachment");
    const cached = await cache.acquire("message:image", async () => {
      unavailableCalls += 1;
      throw new Error("daemon disconnected");
    });

    expect({ cached, unavailableCalls }).toEqual({
      cached: "persisted attachment",
      unavailableCalls: 0,
    });
    expect(cache.peek("message:image")).toBe("persisted attachment");
  });

  it("scopes file acquisitions to the rendered message occurrence", () => {
    const first = createAssistantImageFileAcquisitionKey({
      serverId: "server",
      occurrenceKey: "message-1:image-1",
      cwd: "/workspace",
      path: "screenshot.png",
    });
    const remount = createAssistantImageFileAcquisitionKey({
      serverId: "server",
      occurrenceKey: "message-1:image-1",
      cwd: "/workspace",
      path: "screenshot.png",
    });
    const laterMessage = createAssistantImageFileAcquisitionKey({
      serverId: "server",
      occurrenceKey: "message-2:image-1",
      cwd: "/workspace",
      path: "screenshot.png",
    });

    expect(remount).toBe(first);
    expect(laterMessage).not.toBe(first);
  });

  it("scopes persisted file previews to the rendered message occurrence", () => {
    const first = createAssistantImageFilePreviewAttachmentId({
      serverId: "server-1",
      occurrenceKey: "message-1:image-1",
      mimeType: "image/png",
      path: "/workspace/screenshot.png",
      size: 512,
      modifiedAt: "2026-07-27T12:00:00.000Z",
      contentLength: 512,
    });
    const second = createAssistantImageFilePreviewAttachmentId({
      serverId: "server-1",
      occurrenceKey: "message-2:image-1",
      mimeType: "image/png",
      path: "/workspace/screenshot.png",
      size: 512,
      modifiedAt: "2026-07-27T12:00:00.000Z",
      contentLength: 512,
    });

    expect(second).not.toBe(first);
  });

  it("scopes message occurrences to their agent", () => {
    const first = createAssistantImageOccurrenceKey({ agentId: "agent-1", itemId: "message-1" });
    const second = createAssistantImageOccurrenceKey({ agentId: "agent-2", itemId: "message-1" });

    expect(second).not.toBe(first);
  });

  it("retains successful values until their cache entry is evicted", async () => {
    const retained: string[] = [];
    const released: string[] = [];
    const cache = createAssistantImageAcquisitionCache<string>({
      capacity: 1,
      onRetain(value) {
        retained.push(value);
        return () => released.push(value);
      },
    });

    await cache.acquire("first", async () => "attachment-1");
    expect({ retained, released }).toEqual({ retained: ["attachment-1"], released: [] });

    await cache.acquire("second", async () => "attachment-2");
    expect({ retained, released }).toEqual({
      retained: ["attachment-1", "attachment-2"],
      released: ["attachment-1"],
    });
  });

  it("does not evict a value while an active consumer retains it", async () => {
    const released: string[] = [];
    const cache = createAssistantImageAcquisitionCache<string>({
      capacity: 1,
      onRetain: (value) => () => released.push(value),
    });

    const first = cache.acquireRetained("first", async () => "attachment-1");
    await first.promise;
    const second = cache.acquireRetained("second", async () => "attachment-2");
    await second.promise;

    expect({ released, size: cache.size() }).toEqual({ released: [], size: 2 });

    first.release();
    expect({ released, size: cache.size() }).toEqual({
      released: ["attachment-1"],
      size: 1,
    });
    second.release();
  });

  it("protects every actively consumed attachment from garbage collection past capacity", async () => {
    const cache = createAssistantImageAcquisitionCache<{ id: string }>({
      capacity: 1,
      onRetain: (attachment) => retainAttachmentForGarbageCollection(attachment.id),
    });

    const first = cache.acquireRetained("first", async () => ({ id: "mounted-image-1" }));
    await first.promise;
    const second = cache.acquireRetained("second", async () => ({ id: "mounted-image-2" }));
    await second.promise;

    expect(collectRetainedAttachmentIds()).toEqual(new Set(["mounted-image-1", "mounted-image-2"]));

    first.release();
    expect(collectRetainedAttachmentIds()).toEqual(new Set(["mounted-image-2"]));
    second.release();
    await expect(
      cache.acquire("cleanup", async () => {
        throw new Error("cleanup");
      }),
    ).rejects.toThrow("cleanup");
    expect(collectRetainedAttachmentIds()).toEqual(new Set());
  });
});

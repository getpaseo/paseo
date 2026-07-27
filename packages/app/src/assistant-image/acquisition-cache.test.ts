import { describe, expect, it } from "vitest";
import {
  createAssistantImageAcquisitionCache,
  createAssistantImageFileAcquisitionKey,
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
});

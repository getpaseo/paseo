import { describe, expect, it } from "vitest";
import { createAssistantImageAcquisitionCache } from "./acquisition-cache";

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
});

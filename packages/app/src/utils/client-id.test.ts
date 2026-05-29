import { describe, expect, it } from "vitest";
import { createClientIdResolver, type ClientIdStorage } from "./client-id";

interface InMemoryStorage extends ClientIdStorage {
  items: Map<string, string>;
  setCallCount: number;
}

function inMemoryStorage(initial: Record<string, string> = {}): InMemoryStorage {
  const items = new Map<string, string>(Object.entries(initial));
  const storage: InMemoryStorage = {
    items,
    setCallCount: 0,
    async getItem(key) {
      return items.get(key) ?? null;
    },
    async setItem(key, value) {
      storage.setCallCount += 1;
      items.set(key, value);
    },
  };
  return storage;
}

describe("clientIdResolver", () => {
  it("returns the stored client id when present and does not regenerate", async () => {
    const storage = inMemoryStorage({ "@paseo:client-id-v1": "cid_existing" });
    const resolver = createClientIdResolver({
      storage,
      generateUuid: () => {
        throw new Error("generateUuid should not run when an id is stored");
      },
    });

    expect(await resolver.getOrCreate()).toBe("cid_existing");
    expect(storage.setCallCount).toBe(0);
  });

  it("creates and persists a new client id when storage is empty", async () => {
    const storage = inMemoryStorage();
    const resolver = createClientIdResolver({
      storage,
      generateUuid: () => "123456781234123412341234567890ab",
    });

    expect(await resolver.getOrCreate()).toBe("cid_123456781234123412341234567890ab");
    expect(storage.items.get("@paseo:client-id-v1")).toBe("cid_123456781234123412341234567890ab");
  });

  it("dedupes concurrent callers behind a single storage write", async () => {
    const storage = inMemoryStorage();
    let uuidCalls = 0;
    const resolver = createClientIdResolver({
      storage,
      generateUuid: () => {
        uuidCalls += 1;
        return "abcdef0123456789abcdef0123456789";
      },
    });

    const [first, second] = await Promise.all([resolver.getOrCreate(), resolver.getOrCreate()]);

    expect(first).toBe("cid_abcdef0123456789abcdef0123456789");
    expect(second).toBe(first);
    expect(uuidCalls).toBe(1);
    expect(storage.setCallCount).toBe(1);
  });

  it("ignores stored blank strings and treats them as missing", async () => {
    const storage = inMemoryStorage({ "@paseo:client-id-v1": "   " });
    const resolver = createClientIdResolver({
      storage,
      generateUuid: () => "newuuid",
    });

    expect(await resolver.getOrCreate()).toBe("cid_newuuid");
    expect(storage.items.get("@paseo:client-id-v1")).toBe("cid_newuuid");
  });
});

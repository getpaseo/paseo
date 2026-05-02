import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIndexedDbAttachmentStore } from "./indexeddb-attachment-store";

type Listener = () => void;

class FakeRequest<T = unknown> {
  result!: T;
  error: Error | null = null;
  private listeners = new Map<string, Listener[]>();

  addEventListener(event: string, listener: Listener): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }

  emit(event: string): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener();
    }
  }
}

class FakeObjectStore {
  constructor(private readonly onPut: (record: unknown) => void) {}

  put(record: unknown): FakeRequest<unknown> {
    this.onPut(record);
    const request = new FakeRequest<unknown>();
    queueMicrotask(() => request.emit("success"));
    return request;
  }
}

class FakeTransaction {
  error: Error | null = null;

  constructor(private readonly store: FakeObjectStore) {}

  objectStore(): FakeObjectStore {
    return this.store;
  }

  addEventListener(): void {}
}

class FakeDatabase {
  readonly objectStoreNames = {
    contains: () => true,
  };

  constructor(private readonly store: FakeObjectStore) {}

  createObjectStore(): void {}

  transaction(): FakeTransaction {
    return new FakeTransaction(this.store);
  }

  close(): void {}
}

describe("indexeddb attachment store", () => {
  let storedRecord: unknown;

  beforeEach(() => {
    storedRecord = null;
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: {
        open: () => {
          const store = new FakeObjectStore((record) => {
            storedRecord = record;
          });
          const request = new FakeRequest<FakeDatabase>();
          request.result = new FakeDatabase(store);
          queueMicrotask(() => request.emit("success"));
          return request;
        },
      } as unknown as IDBFactory,
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "indexedDB");
  });

  it("stores raw byte sources as a Blob", async () => {
    const store = createIndexedDbAttachmentStore();
    const bytes = new Uint8Array([0, 1, 2, 3]);

    const attachment = await store.save({
      id: "att_bytes",
      mimeType: "image/png",
      fileName: "image.png",
      source: { kind: "bytes", bytes },
    });

    expect(storedRecord).toEqual({
      id: "att_bytes",
      blob: new Blob([bytes], { type: "image/png" }),
      createdAt: expect.any(Number),
      fileName: "image.png",
    });
    expect(attachment).toMatchObject({
      id: "att_bytes",
      mimeType: "image/png",
      storageType: "web-indexeddb",
      storageKey: "att_bytes",
      fileName: "image.png",
      byteSize: 4,
    });
  });
});

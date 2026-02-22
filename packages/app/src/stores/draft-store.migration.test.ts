import "@/test/window-local-storage";
import { describe, expect, it } from "vitest";
import { __draftStoreTestUtils } from "./draft-store";

describe("draft-store migration", () => {
  it("normalizes attachment metadata and strips persisted preview URLs", () => {
    const migrated = __draftStoreTestUtils.migratePersistedState({
      drafts: {
        "agent:server:agent": {
          input: {
            text: "hello",
            images: [
              {
                id: "att-1",
                mimeType: "image/png",
                storageType: "desktop-file",
                storageKey: "/tmp/att-1.png",
                createdAt: 1700000000000,
                previewUri: "asset://should-not-persist",
              },
            ],
          },
          lifecycle: "active",
          updatedAt: 1700000000001,
          version: 1,
        },
      },
      createModalDraft: null,
    });

    expect(migrated.drafts["agent:server:agent"]?.input.images).toEqual([
      {
        id: "att-1",
        mimeType: "image/png",
        storageType: "desktop-file",
        storageKey: "/tmp/att-1.png",
        createdAt: 1700000000000,
      },
    ]);
  });

  it("is idempotent for already-migrated shapes", () => {
    const original = {
      drafts: {
        "agent:server:agent": {
          input: {
            text: "hello",
            images: [
              {
                id: "att-1",
                mimeType: "image/jpeg",
                storageType: "web-indexeddb",
                storageKey: "att-1",
                createdAt: 1700000000000,
              },
            ],
          },
          lifecycle: "active",
          updatedAt: 1700000000001,
          version: 2,
        },
      },
      createModalDraft: null,
    };

    const once = __draftStoreTestUtils.migratePersistedState(original);
    const twice = __draftStoreTestUtils.migratePersistedState(once);

    expect(twice).toEqual(once);
  });
});

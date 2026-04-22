import "@/test/window-local-storage";
import { describe, expect, it } from "vitest";
import { __draftStoreTestUtils } from "./draft-store";

describe("draft-store migration", () => {
  it("normalizes legacy image metadata into image attachments and strips persisted preview URLs", async () => {
    const migrated = await __draftStoreTestUtils.migratePersistedState({
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

    expect(migrated.drafts["agent:server:agent"]?.input).toEqual({
      text: "hello",
      attachments: [
        {
          kind: "image",
          metadata: {
            id: "att-1",
            mimeType: "image/png",
            storageType: "desktop-file",
            storageKey: "/tmp/att-1.png",
            createdAt: 1700000000000,
          },
        },
      ],
      cwd: "",
    });
  });

  it("is idempotent for already-migrated shapes", async () => {
    const original = {
      drafts: {
        "agent:server:agent": {
          input: {
            text: "hello",
            attachments: [
              {
                kind: "image",
                metadata: {
                  id: "att-1",
                  mimeType: "image/jpeg",
                  storageType: "web-indexeddb",
                  storageKey: "att-1",
                  createdAt: 1700000000000,
                },
              },
            ],
            cwd: "/repo",
          },
          lifecycle: "active",
          updatedAt: 1700000000001,
          version: 2,
        },
      },
      createModalDraft: null,
    };

    const once = await __draftStoreTestUtils.migratePersistedState(original);
    const twice = await __draftStoreTestUtils.migratePersistedState(once);

    expect(twice).toEqual(once);
  });
});

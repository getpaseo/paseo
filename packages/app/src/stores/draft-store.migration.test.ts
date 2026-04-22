import "@/test/window-local-storage";
import { beforeEach, describe, expect, it } from "vitest";
import type { ComposerAttachment } from "@/attachments/types";
import { __draftStoreTestUtils, useDraftStore } from "./draft-store";

function generatedReviewAttachment(): Extract<ComposerAttachment, { kind: "review" }> {
  return {
    kind: "review",
    generated: true,
    reviewDraftKey: "review:key",
    commentCount: 1,
    attachment: {
      type: "review",
      mimeType: "application/paseo-review",
      cwd: "/repo",
      mode: "uncommitted",
      baseRef: null,
      comments: [
        {
          filePath: "src/example.ts",
          side: "new",
          lineNumber: 41,
          body: "Please simplify this.",
          context: {
            hunkHeader: "@@ -40,1 +40,1 @@",
            targetLine: {
              oldLineNumber: null,
              newLineNumber: 41,
              type: "add",
              content: "const value = newValue;",
            },
            lines: [
              {
                oldLineNumber: null,
                newLineNumber: 41,
                type: "add",
                content: "const value = newValue;",
              },
            ],
          },
        },
      ],
    },
  };
}

describe("draft-store migration", () => {
  beforeEach(() => {
    useDraftStore.setState({ drafts: {}, createModalDraft: null });
  });

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

  it("rejects generated review attachments from migrated draft attachments", async () => {
    const migrated = await __draftStoreTestUtils.migratePersistedState({
      drafts: {
        "agent:server:agent": {
          input: {
            text: "hello",
            attachments: [generatedReviewAttachment()],
            cwd: "/repo",
          },
          lifecycle: "active",
          updatedAt: 1700000000001,
          version: 2,
        },
      },
      createModalDraft: null,
    });

    expect(migrated.drafts["agent:server:agent"]?.input.attachments).toEqual([]);
  });
});

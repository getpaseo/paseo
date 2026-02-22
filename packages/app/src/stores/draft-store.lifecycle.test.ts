import "@/test/window-local-storage";
import { describe, expect, it } from "vitest";
import { __draftStoreTestUtils } from "./draft-store";

describe("draft-store lifecycle", () => {
  it("prunes finalized tombstones after TTL", () => {
    const nowMs = 1_000_000;
    const drafts = {
      oldSent: {
        input: { text: "", images: [] },
        lifecycle: "sent" as const,
        updatedAt: 0,
        version: 2,
      },
      recentAbandoned: {
        input: { text: "", images: [] },
        lifecycle: "abandoned" as const,
        updatedAt: nowMs + 2 * 60 * 1000,
        version: 2,
      },
      active: {
        input: { text: "a", images: [] },
        lifecycle: "active" as const,
        updatedAt: 0,
        version: 1,
      },
    };

    const pruned = __draftStoreTestUtils.pruneFinalizedDraftRecords({
      drafts,
      nowMs: nowMs + 6 * 60 * 1000,
    });

    expect(pruned.oldSent).toBeUndefined();
    expect(pruned.recentAbandoned).toBeDefined();
    expect(pruned.active).toBeDefined();
  });

  it("normalizes clear-with-lifecycle into a tombstone without attachments", () => {
    const cleared = __draftStoreTestUtils.applyClearDraftRecord({
      record: {
        input: {
          text: "hello",
          images: [
            {
              id: "att-1",
              mimeType: "image/jpeg",
              storageType: "web-indexeddb",
              storageKey: "att-1",
              createdAt: 1,
            },
          ],
        },
        lifecycle: "active",
        updatedAt: 1,
        version: 1,
      },
      lifecycle: "sent",
      nowMs: 2,
    });

    expect(cleared).toEqual({
      input: { text: "", images: [] },
      lifecycle: "sent",
      updatedAt: 2,
      version: 2,
    });
  });
});

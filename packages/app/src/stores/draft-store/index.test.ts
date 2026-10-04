import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachmentMetadata, AttachmentStore } from "@/attachments/types";
import { __setAttachmentStoreForTests } from "@/attachments/store";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  },
}));

function createCountingStore(): AttachmentStore & { garbageCollections: number } {
  const store = {
    storageType: "web-indexeddb" as const,
    garbageCollections: 0,
    async save(): Promise<AttachmentMetadata> {
      throw new Error("not used");
    },
    async encodeBase64() {
      return "";
    },
    async resolvePreviewUrl() {
      return "";
    },
    async delete() {},
    async garbageCollect() {
      store.garbageCollections += 1;
    },
  };
  return store;
}

const image: AttachmentMetadata = {
  id: "attachment-1",
  mimeType: "image/png",
  storageType: "web-indexeddb",
  storageKey: "attachments/1",
  createdAt: 1,
};

async function settleScheduledWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("draft store attachment garbage collection", () => {
  let attachmentStore: ReturnType<typeof createCountingStore>;
  let useDraftStore: typeof import("./index").useDraftStore;

  // The store collects once on rehydrate, which happens at import; the store under test must
  // be in place before then or every later collection queues behind a real one.
  beforeAll(async () => {
    __setAttachmentStoreForTests(createCountingStore());
    ({ useDraftStore } = await import("./index"));
    await settleScheduledWork();
  }, 60_000);

  afterAll(() => {
    __setAttachmentStoreForTests(null);
  });

  beforeEach(() => {
    attachmentStore = createCountingStore();
    __setAttachmentStoreForTests(attachmentStore);
    useDraftStore.setState({
      drafts: {},
      createModalDraft: null,
      attachmentFocusRequestByDraftKey: {},
    });
  });

  it("does not collect attachments while only the text changes", async () => {
    const { saveDraftInput } = useDraftStore.getState();
    const text = "typing a message one character at a time";
    // Keystrokes arrive one per task, so each save gets its own scheduling window.
    for (let length = 1; length <= text.length; length += 1) {
      saveDraftInput({
        draftKey: "draft:text",
        draft: { text: text.slice(0, length), attachments: [] },
      });
      await settleScheduledWork();
    }

    expect(useDraftStore.getState().drafts["draft:text"]?.input.text).toBe(text);
    expect(attachmentStore.garbageCollections).toBe(0);
  });

  it("collects attachments when the referenced attachment ids change", async () => {
    const { saveDraftInput, clearDraftInput } = useDraftStore.getState();
    saveDraftInput({
      draftKey: "draft:images",
      draft: { text: "with image", attachments: [{ kind: "image", metadata: image }] },
    });
    await settleScheduledWork();
    expect(attachmentStore.garbageCollections).toBe(1);

    saveDraftInput({
      draftKey: "draft:images",
      draft: { text: "with image, edited", attachments: [{ kind: "image", metadata: image }] },
    });
    await settleScheduledWork();
    expect(attachmentStore.garbageCollections).toBe(1);

    saveDraftInput({
      draftKey: "draft:images",
      draft: { text: "with image, edited", attachments: [] },
    });
    await settleScheduledWork();
    expect(attachmentStore.garbageCollections).toBe(2);

    clearDraftInput({ draftKey: "draft:images", lifecycle: "sent" });
    await settleScheduledWork();
    expect(attachmentStore.garbageCollections).toBe(3);
  });
});

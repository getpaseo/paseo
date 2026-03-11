import { afterEach, describe, expect, it } from "vitest";
import { __setAttachmentStoreForTests, getAttachmentStore } from "./store";

describe("attachment store", () => {
  afterEach(() => {
    __setAttachmentStoreForTests(null);
  });

  it("creates the default web attachment store without runtime module resolution errors", async () => {
    const store = await getAttachmentStore();

    expect(store.storageType).toBe("web-indexeddb");
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { useDraftStore } from "./index";

const draftKey = "draft:metadata";

describe("a draft's plugin metadata", () => {
  beforeEach(() => {
    useDraftStore.setState({ drafts: {}, metadataByDraftKey: {} });
  });

  it("is there when the draft's composer mounts again", () => {
    const store = useDraftStore.getState();
    store.editDraftText({ draftKey, text: "review this" });
    store.patchDraftMetadata({ draftKey, patch: { "plugin.review": true, "plugin.tag": "a" } });
    store.patchDraftMetadata({ draftKey, patch: { "plugin.tag": null } });

    // A remount reads the store again; nothing from the unmounted composer is kept.
    const remounted = useDraftStore.getState();
    expect(remounted.getDraftInput(draftKey)?.text).toBe("review this");
    expect(remounted.metadataByDraftKey[draftKey]).toEqual({ "plugin.review": true });
  });

  it("is dropped with the prompt once the draft is sent, and not before", () => {
    const store = useDraftStore.getState();
    store.patchDraftMetadata({ draftKey, patch: { "plugin.review": true } });

    store.clearDraftInput({ draftKey, lifecycle: "abandoned" });
    expect(useDraftStore.getState().metadataByDraftKey[draftKey]).toEqual({
      "plugin.review": true,
    });

    store.clearDraftMetadata({ draftKey });
    expect(useDraftStore.getState().metadataByDraftKey[draftKey]).toBeUndefined();
  });
});

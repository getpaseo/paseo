import { beforeEach, describe, expect, it } from "vitest";
import { useDraftStore } from "./index";
import { migratePersistedState, PersistedDraftStoreSchema } from "./migration";
import { draftCreationKey } from "@/composer/draft/creation-key";

const draftKey = "draft:metadata";

describe("a draft's plugin metadata", () => {
  beforeEach(() => {
    useDraftStore.setState({ drafts: {}, metadataByDraftKey: {}, creationIdByDraftKey: {} });
  });

  it("restores the same creation identity and request metadata after a persisted reload", async () => {
    const state = useDraftStore.getState();
    state.editDraftText({ draftKey, text: "review this" });
    state.patchDraftMetadata({ draftKey, patch: { "plugin.review": true } });
    const id = state.ensureDraftCreationId({ draftKey, proposedId: "first-generated-id" });
    const request = { initialPrompt: "review this", metadata: { "plugin.review": true } };
    const originalKey = draftCreationKey(id, request);
    const partialize = useDraftStore.persist.getOptions().partialize!;
    const saved = PersistedDraftStoreSchema.parse(
      JSON.parse(JSON.stringify(partialize(useDraftStore.getState()))),
    );
    const restored = await migratePersistedState(saved, {
      migrateLegacyImages: async () => [],
      nowMs: 1,
    });
    useDraftStore.setState({
      ...restored,
      metadataByDraftKey: restored.metadataByDraftKey ?? {},
      creationIdByDraftKey: restored.creationIdByDraftKey ?? {},
    });
    const remounted = useDraftStore.getState();
    const retained = remounted.ensureDraftCreationId({
      draftKey,
      proposedId: "regenerated-on-remount",
    });
    expect(retained).toBe("first-generated-id");
    expect(
      draftCreationKey(retained, {
        initialPrompt: remounted.getDraftInput(draftKey)?.text,
        metadata: remounted.metadataByDraftKey[draftKey],
      }),
    ).toBe(originalKey);
    remounted.clearDraftCreationId({ draftKey });
    expect(
      useDraftStore.getState().ensureDraftCreationId({ draftKey, proposedId: "next-draft" }),
    ).toBe("next-draft");
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

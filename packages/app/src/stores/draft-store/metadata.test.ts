/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from "vitest";
import { useDraftStore, prepareDraftCreation, claimDraftCreation } from "./index";
import { migratePersistedState, PersistedDraftStoreSchema } from "./migration";
import { draftCreationKey } from "@/composer/draft/creation-key";

const draftKey = "draft:metadata";
const serverId = "host-A";

describe("a draft's plugin metadata", () => {
  beforeEach(() => {
    useDraftStore.setState({ drafts: {}, metadataByDraftKey: {}, creationIdByDraftKey: {} });
  });

  it("retiring host B preserves host A's identity through persistence and reload", async () => {
    const state = useDraftStore.getState();
    expect(state.ensureDraftCreationId({ serverId, draftKey, proposedId: "pending-on-A" })).toBe(
      "pending-on-A",
    );
    expect(
      state.ensureDraftCreationId({ serverId: "host-B", draftKey, proposedId: "terminal-on-B" }),
    ).toBe("terminal-on-B");
    state.clearDraftCreationId({ serverId: "host-B", draftKey });
    const saved = PersistedDraftStoreSchema.parse(
      JSON.parse(
        JSON.stringify(useDraftStore.persist.getOptions().partialize!(useDraftStore.getState())),
      ),
    );
    const restored = await migratePersistedState(saved, {
      migrateLegacyImages: async () => [],
      nowMs: 1,
    });
    useDraftStore.setState({
      ...restored,
      creationIdByDraftKey: restored.creationIdByDraftKey ?? {},
    });
    expect(
      useDraftStore
        .getState()
        .ensureDraftCreationId({ serverId, draftKey, proposedId: "must-not-replace-A" }),
    ).toBe("pending-on-A");
    expect(
      useDraftStore
        .getState()
        .ensureDraftCreationId({ serverId: "host-B", draftKey, proposedId: "next-on-B" }),
    ).toBe("next-on-B");
  });

  it("retains a legacy shared ID for unvisited hosts while a retired host gets a fresh ID", async () => {
    useDraftStore.setState({ creationIdByDraftKey: { [draftKey]: "legacy-pending" } });
    const state = useDraftStore.getState();
    expect(
      state.ensureDraftCreationId({ serverId: "host-B", draftKey, proposedId: "ignored" }),
    ).toBe("legacy-pending");
    state.clearDraftCreationId({ serverId: "host-B", draftKey });
    const saved = PersistedDraftStoreSchema.parse(
      JSON.parse(
        JSON.stringify(useDraftStore.persist.getOptions().partialize!(useDraftStore.getState())),
      ),
    );
    const restored = await migratePersistedState(saved, {
      migrateLegacyImages: async () => [],
      nowMs: 1,
    });
    useDraftStore.setState({
      ...restored,
      creationIdByDraftKey: restored.creationIdByDraftKey ?? {},
    });
    expect(
      useDraftStore
        .getState()
        .ensureDraftCreationId({ serverId, draftKey, proposedId: "ignored-on-A" }),
    ).toBe("legacy-pending");
    expect(
      useDraftStore
        .getState()
        .ensureDraftCreationId({ serverId: "host-B", draftKey, proposedId: "fresh-on-B" }),
    ).toBe("fresh-on-B");
  });

  it("restores the same creation identity and request metadata after a persisted reload", async () => {
    const state = useDraftStore.getState();
    state.editDraftText({ draftKey, text: "review this" });
    state.patchDraftMetadata({ draftKey, patch: { "plugin.review": true } });
    const id = state.ensureDraftCreationId({
      serverId,
      draftKey,
      proposedId: "first-generated-id",
    });
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
      serverId,
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
    remounted.clearDraftCreationId({ serverId, draftKey });
    expect(
      useDraftStore
        .getState()
        .ensureDraftCreationId({ serverId, draftKey, proposedId: "next-draft" }),
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

it("allocates a fresh creation identity for an explicit content draft after retirement and reload", async () => {
  useDraftStore.setState({ drafts: {}, metadataByDraftKey: {}, creationIdByDraftKey: {} });
  const input = { serverId, draftKey, proposedId: "explicit-fork-route" };
  const original = await prepareDraftCreation(input);
  const store = useDraftStore.getState();
  store.editDraftText({ draftKey, text: "A newer fork idea" });
  store.clearDraftCreationId(input);
  const saved = PersistedDraftStoreSchema.parse(
    JSON.parse(
      JSON.stringify(useDraftStore.persist.getOptions().partialize!(useDraftStore.getState())),
    ),
  );
  const restored = await migratePersistedState(saved, {
    migrateLegacyImages: async () => [],
    nowMs: 1,
  });
  useDraftStore.setState({
    ...restored,
    creationIdByDraftKey: restored.creationIdByDraftKey ?? {},
  });
  const next = await prepareDraftCreation(input);
  expect(next).not.toBe(original);
  expect(next).toMatch(/^draft_/);
  expect(await prepareDraftCreation(input)).toBe(next);
  expect(useDraftStore.getState().getDraftInput(draftKey)?.text).toBe("A newer fork idea");
});

it("reclaims a prepared ID retired before admission without overriding a newer owner", async () => {
  useDraftStore.setState({ drafts: {}, metadataByDraftKey: {}, creationIdByDraftKey: {} });
  const input = { serverId, draftKey, proposedId: "explicit-route-to-claim" };
  const prepared = await prepareDraftCreation(input);
  useDraftStore.getState().clearDraftCreationId(input);
  await claimDraftCreation({ serverId, draftKey, expectedId: prepared });
  expect(useDraftStore.getState().getDraftCreationId(input)).toBe(prepared);
  useDraftStore.getState().clearDraftCreationId(input);
  const newer = await prepareDraftCreation(input);
  await expect(claimDraftCreation({ serverId, draftKey, expectedId: prepared })).rejects.toThrow(
    "The draft now belongs to another start",
  );
  expect(useDraftStore.getState().getDraftCreationId(input)).toBe(newer);
});

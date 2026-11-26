import { create } from "zustand";
import { persist } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { AttachmentMetadata, WorkspaceFileComposerAttachment } from "@/attachments/types";
import { appendWorkspaceFileAttachment } from "@/attachments/workspace-file";
import {
  garbageCollectAttachments,
  persistAttachmentFromDataUrl,
  persistAttachmentFromFileUri,
} from "@/attachments/service";
import { collectRetainedAttachmentIds } from "@/attachments/gc-retention";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import { useSessionStore, type SessionState } from "@/stores/session-store";
import { useWorkspaceAttachmentsStore } from "@/attachments/workspace-attachments-store";
import {
  applyClearDraftRecord,
  editDraftRecordText,
  collectReferencedAttachmentIdsFromState,
  DRAFT_STORE_VERSION,
  isAttachmentMetadata,
  isCanonicalDraftInput,
  isLegacyDraftImage,
  normalizeComposerAttachment,
  pruneFinalizedDraftRecords,
  toDraftInputIfReady,
  type DraftInput,
  type DraftLifecycleState,
  type DraftRecord,
  type DraftStoreState,
} from "./state";
import {
  migrateDraftInput,
  migratePersistedState,
  type MigrateLegacyImages,
  PersistedDraftStoreSchema,
} from "./migration";
import { createDraftPersistStorage } from "./persistence";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import { applyMetadataPatch } from "@/composer/draft/metadata";
import { hasDraftContent } from "@/composer/draft/input-draft-core";
import { generateDraftId } from "@/stores/draft-keys";

export type { DraftInput, DraftLifecycleState } from "./state";

interface DraftStoreActions {
  getDraftInput: (draftKey: string) => DraftInput | undefined;
  hydrateDraftInput: (input: { draftKey: string }) => Promise<DraftInput | undefined>;
  saveDraftInput: (input: { draftKey: string; draft: DraftInput }) => void;
  /** Saves what `update` makes of the current input; an emptied input abandons the draft. */
  updateDraftInput: (input: {
    draftKey: string;
    update: (current: DraftInput) => DraftInput;
  }) => void;
  editDraftText: (input: { draftKey: string; text: string }) => void;
  /**
   * Sets the text on behalf of something other than the input, which then shows it. Use
   * `editDraftText` for the input's own edits.
   */
  replaceDraftText: (input: { draftKey: string; text: string }) => void;
  markDraftLifecycle: (input: { draftKey: string; lifecycle: DraftLifecycleState }) => void;
  clearDraftInput: (input: {
    draftKey: string;
    lifecycle?: Exclude<DraftLifecycleState, "active">;
  }) => void;
  /** Plugin metadata the draft will create its agent with; see `composer/draft/metadata`. */
  patchDraftMetadata: (input: { draftKey: string; patch: Record<string, JsonValue> }) => void;
  clearDraftMetadata: (input: { draftKey: string }) => void;
  getDraftCreationId: (input: { serverId: string; draftKey: string }) => string | undefined;
  ensureDraftCreationId: (input: {
    serverId: string;
    draftKey: string;
    proposedId: string;
  }) => string;
  clearDraftCreationId: (input: { serverId: string; draftKey: string }) => void;
  attachWorkspaceFile: (input: {
    draftKey: string;
    attachment: WorkspaceFileComposerAttachment;
  }) => Promise<void>;
  getCreateModalDraft: () => DraftInput | null;
  saveCreateModalDraft: (draft: DraftInput | null) => void;
  collectActiveAttachmentIds: () => string[];
}

interface DraftStoreRuntimeState {
  attachmentFocusRequestByDraftKey: Record<string, number>;
  /** Counts `replaceDraftText`, so a mounted input knows to show text it did not type. */
  textReplacementRequestByDraftKey: Record<string, number>;
  /**
   * Kept beside the prompt so a composer that remounts finds it. Persisted, and not cleared
   * with an emptied prompt: a plugin's choice outlives the text until the draft is sent.
   */
  metadataByDraftKey: Record<string, Record<string, JsonValue>>;
  creationIdByDraftKey: Record<string, string | null>;
}

type DraftStore = DraftStoreState & DraftStoreRuntimeState & DraftStoreActions;

let gcScheduled = false;
const draftPersistStorage = createDraftPersistStorage(
  createValidatedPersistStorage(AsyncStorage, PersistedDraftStoreSchema),
);

let finishInitialHydration: () => void;
let hydrationError: unknown;
const initialHydration = new Promise<void>((resolve) => {
  finishInitialHydration = resolve;
});

export async function prepareDraftCreation(input: {
  serverId: string;
  draftKey: string;
  proposedId: string;
  reclaimRetired?: boolean;
}): Promise<string> {
  await initialHydration;
  if (hydrationError !== undefined) {
    await useDraftStore.persist.rehydrate();
    if (hydrationError !== undefined) throw hydrationError;
  }
  const store = useDraftStore.getState();
  const retired =
    store.creationIdByDraftKey[JSON.stringify([input.serverId, input.draftKey])] === null;
  const proposedId = retired && !input.reclaimRetired ? generateDraftId() : input.proposedId;
  const id = store.ensureDraftCreationId({ ...input, proposedId });
  await draftPersistStorage.checkpoint("paseo-drafts", {
    state: persistedDraftState(useDraftStore.getState()),
    version: DRAFT_STORE_VERSION,
  });
  return id;
}

/** Called under the creation admission lock, so a late terminal cannot detach this start. */
export async function claimDraftCreation(input: {
  serverId: string;
  draftKey: string;
  expectedId: string;
}): Promise<void> {
  const actual = await prepareDraftCreation({
    serverId: input.serverId,
    draftKey: input.draftKey,
    proposedId: input.expectedId,
    reclaimRetired: true,
  });
  if (actual !== input.expectedId)
    throw new Error(
      "The draft now belongs to another start. Submit it again from the current draft.",
    );
}

function persistedDraftState({
  drafts,
  createModalDraft,
  metadataByDraftKey,
  creationIdByDraftKey,
}: DraftStore) {
  return { drafts, createModalDraft, metadataByDraftKey, creationIdByDraftKey };
}

export function flushDraftPersistStorage(): Promise<void> {
  return draftPersistStorage?.flush() ?? Promise.resolve();
}

function createDraftRecord(input: {
  draft: DraftInput;
  lifecycle: DraftLifecycleState;
  previousVersion?: number;
}): DraftRecord {
  return {
    input: {
      text: input.draft.text,
      attachments: input.draft.attachments.map(normalizeComposerAttachment),
    },
    lifecycle: input.lifecycle,
    updatedAt: Date.now(),
    version: (input.previousVersion ?? 0) + 1,
  };
}

const migrateLegacyImages: MigrateLegacyImages = async (images) => {
  if (images.length === 0) {
    return [];
  }

  const migrated = await Promise.all(
    images.map(async (entry) => {
      if (isAttachmentMetadata(entry)) {
        return entry;
      }
      if (!isLegacyDraftImage(entry)) {
        return null;
      }

      try {
        if (entry.uri.startsWith("data:")) {
          return await persistAttachmentFromDataUrl({
            dataUrl: entry.uri,
            mimeType: entry.mimeType,
          });
        }

        return await persistAttachmentFromFileUri({
          uri: entry.uri,
          mimeType: entry.mimeType,
        });
      } catch (error) {
        console.warn("[DraftStore] Failed to migrate legacy draft attachment", {
          uri: entry.uri,
          error,
        });
        return null;
      }
    }),
  );

  return migrated.filter((entry): entry is AttachmentMetadata => entry !== null);
};

async function runAttachmentGc(): Promise<void> {
  gcScheduled = false;
  const nowMs = Date.now();

  useDraftStore.setState((state) => {
    const prunedDrafts = pruneFinalizedDraftRecords({ drafts: state.drafts, nowMs });
    if (prunedDrafts === state.drafts) {
      return state;
    }
    return {
      ...state,
      drafts: prunedDrafts,
    };
  });

  const referencedIds = new Set<string>();
  for (const id of useDraftStore.getState().collectActiveAttachmentIds()) {
    referencedIds.add(id);
  }
  for (const id of collectRetainedAttachmentIds()) {
    referencedIds.add(id);
  }

  const pendingByDraftId = useCreateFlowStore.getState().pendingByDraftId;
  for (const pendingCreate of Object.values(pendingByDraftId)) {
    if (pendingCreate.lifecycle !== "active" || !pendingCreate.images) {
      continue;
    }
    for (const image of pendingCreate.images) {
      referencedIds.add(image.id);
    }
  }

  const sessions = useSessionStore.getState().sessions;
  for (const session of Object.values(sessions)) {
    collectQueuedMessageAttachmentIds(session, referencedIds);
    collectStreamUserImageIds(session.agentStreamTail, referencedIds);
    collectStreamUserImageIds(session.agentStreamHead, referencedIds);
  }

  // Browser-element screenshots live in the workspace attachment store, not in
  // drafts, so collect their ids here to keep them from being garbage collected
  // before the user sends the message.
  const attachmentsByScope = useWorkspaceAttachmentsStore.getState().attachmentsByScope;
  for (const attachments of Object.values(attachmentsByScope)) {
    for (const attachment of attachments) {
      if (attachment.kind === "browser_element" && attachment.attachment.screenshot) {
        referencedIds.add(attachment.attachment.screenshot.id);
      }
    }
  }

  try {
    await garbageCollectAttachments({ referencedIds });
  } catch (error) {
    console.warn("[DraftStore] Attachment garbage collection failed", error);
  }
}

function collectQueuedMessageAttachmentIds(
  session: SessionState,
  referencedIds: Set<string>,
): void {
  for (const queue of session.queuedMessages.values()) {
    for (const queuedMessage of queue) {
      for (const attachment of queuedMessage.attachments) {
        if (attachment.kind === "image") {
          referencedIds.add(attachment.metadata.id);
        }
      }
    }
  }
}

function collectStreamUserImageIds(
  streams: SessionState["agentStreamTail"],
  referencedIds: Set<string>,
): void {
  for (const stream of streams.values()) {
    for (const item of stream) {
      if (item.kind !== "user_message") continue;
      for (const image of item.images ?? []) {
        referencedIds.add(image.id);
      }
    }
  }
}

function scheduleAttachmentGc(): void {
  if (gcScheduled) {
    return;
  }
  gcScheduled = true;
  if (typeof queueMicrotask === "function") {
    queueMicrotask(() => {
      void runAttachmentGc();
    });
    return;
  }
  setTimeout(() => {
    void runAttachmentGc();
  }, 0);
}

async function migrateAllLegacyDrafts(): Promise<void> {
  const state = useDraftStore.getState();
  const keys = Object.entries(state.drafts)
    .filter(([, record]) => record.lifecycle === "active" && !isCanonicalDraftInput(record.input))
    .map(([draftKey]) => draftKey);

  for (const draftKey of keys) {
    try {
      await state.hydrateDraftInput({ draftKey });
    } catch (error) {
      console.warn("[DraftStore] Failed to migrate draft during startup", {
        draftKey,
        error,
      });
    }
  }
}

export const useDraftStore = create<DraftStore>()(
  persist(
    (set, get) => ({
      drafts: {},
      createModalDraft: null,
      attachmentFocusRequestByDraftKey: {},
      textReplacementRequestByDraftKey: {},
      metadataByDraftKey: {},
      creationIdByDraftKey: {},

      getDraftCreationId: (input) => {
        const ids = get().creationIdByDraftKey;
        const scoped = ids[JSON.stringify([input.serverId, input.draftKey])];
        // COMPAT(hostScopedDraftCreationIds): added in v0.17.3, remove after 2027-05-27.
        // Missing host entries inherit older shared IDs; null retires one host's claim only.
        return scoped === null ? undefined : (scoped ?? ids[input.draftKey] ?? undefined);
      },
      ensureDraftCreationId: (input) => {
        const scopeKey = JSON.stringify([input.serverId, input.draftKey]);
        const id = get().getDraftCreationId(input) ?? input.proposedId;
        if (get().creationIdByDraftKey[scopeKey] !== id) {
          set((state) => ({
            creationIdByDraftKey: { ...state.creationIdByDraftKey, [scopeKey]: id },
          }));
        }
        return id;
      },
      clearDraftCreationId: (input) =>
        set((state) => ({
          creationIdByDraftKey: {
            ...state.creationIdByDraftKey,
            [JSON.stringify([input.serverId, input.draftKey])]: null,
          },
        })),

      getDraftInput: (draftKey) => {
        const record = get().drafts[draftKey];
        return toDraftInputIfReady(record);
      },

      hydrateDraftInput: async ({ draftKey }) => {
        const current = get().drafts[draftKey];
        if (!current) {
          return undefined;
        }
        if (current.lifecycle !== "active") {
          return undefined;
        }
        const ready = toDraftInputIfReady(current);
        if (ready) {
          return ready;
        }

        const migratedDraft = await migrateDraftInput(
          { rawInput: current.input },
          { migrateLegacyImages },
        );

        set((state) => {
          const existing = state.drafts[draftKey];
          if (!existing || existing.version !== current.version) {
            return state;
          }
          return {
            drafts: {
              ...state.drafts,
              [draftKey]: createDraftRecord({
                draft: migratedDraft,
                lifecycle: existing.lifecycle,
                previousVersion: existing.version,
              }),
            },
          };
        });

        scheduleAttachmentGc();
        return migratedDraft;
      },

      saveDraftInput: ({ draftKey, draft }) => {
        set((state) => {
          const existing = state.drafts[draftKey];
          return {
            drafts: {
              ...state.drafts,
              [draftKey]: createDraftRecord({
                draft,
                lifecycle: "active",
                previousVersion: existing?.version,
              }),
            },
          };
        });
        scheduleAttachmentGc();
      },

      updateDraftInput: ({ draftKey, update }) => {
        const next = update(get().getDraftInput(draftKey) ?? { text: "", attachments: [] });
        if (hasDraftContent(next)) get().saveDraftInput({ draftKey, draft: next });
        else get().clearDraftInput({ draftKey, lifecycle: "abandoned" });
      },

      editDraftText: ({ draftKey, text }) => {
        set((state) => {
          const previous = state.drafts[draftKey];
          const next = editDraftRecordText(previous, text, Date.now());
          return next === previous ? state : { drafts: { ...state.drafts, [draftKey]: next } };
        });
      },

      replaceDraftText: ({ draftKey, text }) => {
        get().editDraftText({ draftKey, text });
        set((state) => ({
          textReplacementRequestByDraftKey: {
            ...state.textReplacementRequestByDraftKey,
            [draftKey]: (state.textReplacementRequestByDraftKey[draftKey] ?? 0) + 1,
          },
        }));
      },

      markDraftLifecycle: ({ draftKey, lifecycle }) => {
        set((state) => {
          const existing = state.drafts[draftKey];
          if (!existing || existing.lifecycle === lifecycle) {
            return state;
          }
          return {
            drafts: {
              ...state.drafts,
              [draftKey]: {
                ...existing,
                lifecycle,
                updatedAt: Date.now(),
                version: existing.version + 1,
              },
            },
          };
        });
        scheduleAttachmentGc();
      },

      clearDraftInput: ({ draftKey, lifecycle }) => {
        set((state) => {
          const existing = state.drafts[draftKey];
          if (!existing) {
            return state;
          }
          const cleared = applyClearDraftRecord({
            record: existing,
            lifecycle,
            nowMs: Date.now(),
          });
          if (cleared) {
            return {
              drafts: {
                ...state.drafts,
                [draftKey]: cleared,
              },
            };
          }
          const nextDrafts = { ...state.drafts };
          delete nextDrafts[draftKey];
          return { drafts: nextDrafts };
        });

        scheduleAttachmentGc();
      },

      patchDraftMetadata: ({ draftKey, patch }) => {
        set((state) => {
          const next = applyMetadataPatch(state.metadataByDraftKey[draftKey] ?? {}, patch);
          const { [draftKey]: _previous, ...others } = state.metadataByDraftKey;
          return {
            metadataByDraftKey:
              Object.keys(next).length > 0 ? { ...others, [draftKey]: next } : others,
          };
        });
      },

      clearDraftMetadata: ({ draftKey }) => {
        set((state) => {
          if (!(draftKey in state.metadataByDraftKey)) return state;
          const { [draftKey]: _removed, ...others } = state.metadataByDraftKey;
          return { metadataByDraftKey: others };
        });
      },

      attachWorkspaceFile: async ({ draftKey, attachment }) => {
        await get().hydrateDraftInput({ draftKey });
        set((state) => {
          const existing = state.drafts[draftKey];
          const draft = toDraftInputIfReady(existing) ?? { text: "", attachments: [] };
          return {
            drafts: {
              ...state.drafts,
              [draftKey]: createDraftRecord({
                draft: {
                  ...draft,
                  attachments: appendWorkspaceFileAttachment(draft.attachments, attachment),
                },
                lifecycle: "active",
                previousVersion: existing?.version,
              }),
            },
            attachmentFocusRequestByDraftKey: {
              ...state.attachmentFocusRequestByDraftKey,
              [draftKey]: (state.attachmentFocusRequestByDraftKey[draftKey] ?? 0) + 1,
            },
          };
        });
        scheduleAttachmentGc();
      },

      getCreateModalDraft: () => {
        const record = get().createModalDraft;
        return toDraftInputIfReady(record) ?? null;
      },

      saveCreateModalDraft: (draft) => {
        set((state) => {
          if (!draft) {
            return { createModalDraft: null };
          }
          return {
            createModalDraft: createDraftRecord({
              draft,
              lifecycle: "active",
              previousVersion: state.createModalDraft?.version,
            }),
          };
        });
        scheduleAttachmentGc();
      },

      collectActiveAttachmentIds: () => {
        return Array.from(collectReferencedAttachmentIdsFromState(get()).values());
      },
    }),
    {
      name: "paseo-drafts",
      version: DRAFT_STORE_VERSION,
      storage: draftPersistStorage,
      partialize: persistedDraftState,
      migrate: (state) =>
        migratePersistedState(state, {
          migrateLegacyImages,
          nowMs: Date.now(),
        }),
      onRehydrateStorage: () => {
        return (_state, error) => {
          hydrationError = error;
          finishInitialHydration();
          void migrateAllLegacyDrafts();
          scheduleAttachmentGc();
        };
      },
    },
  ),
);

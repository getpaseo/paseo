import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { AttachmentMetadata } from "@/attachments/types";
import {
  garbageCollectAttachments,
  persistAttachmentFromDataUrl,
  persistAttachmentFromFileUri,
} from "@/attachments/service";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import { useSessionStore, type SessionState } from "@/stores/session-store";
import { useWorkspaceAttachmentsStore } from "@/attachments/workspace-attachments-store";
import {
  applyClearDraftRecord,
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
import { migrateDraftInput, migratePersistedState, type MigrateLegacyImages } from "./migration";
import { createDraftPersistStorage } from "./persistence";

export type { DraftInput, DraftLifecycleState } from "./state";

interface DraftStoreActions {
  getDraftInput: (draftKey: string) => DraftInput | undefined;
  hydrateDraftInput: (input: { draftKey: string }) => Promise<DraftInput | undefined>;
  saveDraftInput: (input: { draftKey: string; draft: DraftInput }) => void;
  markDraftLifecycle: (input: { draftKey: string; lifecycle: DraftLifecycleState }) => void;
  clearDraftInput: (input: {
    draftKey: string;
    lifecycle?: Exclude<DraftLifecycleState, "active">;
  }) => void;
  getCreateModalDraft: () => DraftInput | null;
  saveCreateModalDraft: (draft: DraftInput | null) => void;
  beginDraftGeneration: (draftKey: string) => number;
  isDraftGenerationCurrent: (input: { draftKey: string; generation: number }) => boolean;
  collectActiveAttachmentIds: () => string[];
}

type DraftStore = DraftStoreState & DraftStoreActions;

const draftGenerations = new Map<string, number>();
let gcScheduled = false;
const draftPersistStorage = createDraftPersistStorage(
  createJSONStorage<DraftStoreState>(() => AsyncStorage),
);

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

        draftGenerations.delete(draftKey);
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

      beginDraftGeneration: (draftKey) => {
        const next = (draftGenerations.get(draftKey) ?? 0) + 1;
        draftGenerations.set(draftKey, next);
        return next;
      },

      isDraftGenerationCurrent: ({ draftKey, generation }) => {
        return (draftGenerations.get(draftKey) ?? 0) === generation;
      },

      collectActiveAttachmentIds: () => {
        return Array.from(collectReferencedAttachmentIdsFromState(get()).values());
      },
    }),
    {
      name: "paseo-drafts",
      version: DRAFT_STORE_VERSION,
      storage: draftPersistStorage,
      migrate: (persistedState) => {
        return migratePersistedState(persistedState, {
          migrateLegacyImages,
          nowMs: Date.now(),
        });
      },
      onRehydrateStorage: () => {
        return () => {
          void migrateAllLegacyDrafts();
          scheduleAttachmentGc();
        };
      },
    },
  ),
);

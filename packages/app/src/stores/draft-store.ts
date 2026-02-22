import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { AttachmentMetadata } from "@/attachments/types";
import {
  garbageCollectAttachments,
  persistAttachmentFromDataUrl,
  persistAttachmentFromFileUri,
} from "@/attachments/service";

const DRAFT_STORE_VERSION = 2;
const FINALIZED_DRAFT_TTL_MS = 5 * 60 * 1000;

type LegacyDraftImage = {
  uri: string;
  mimeType?: string;
};

type PersistedDraftImage = AttachmentMetadata | LegacyDraftImage;

export interface DraftInput {
  text: string;
  images: AttachmentMetadata[];
}

export type DraftLifecycleState = "active" | "abandoned" | "sent";

interface DraftRecord {
  input: {
    text: string;
    images: PersistedDraftImage[];
  };
  lifecycle: DraftLifecycleState;
  updatedAt: number;
  version: number;
}

interface DraftStoreState {
  drafts: Record<string, DraftRecord>;
  createModalDraft: DraftRecord | null;
}

interface DraftStoreActions {
  getDraftInput: (draftKey: string) => DraftInput | undefined;
  hydrateDraftInput: (draftKey: string) => Promise<DraftInput | undefined>;
  saveDraftInput: (input: { draftKey: string; draft: DraftInput }) => void;
  markDraftLifecycle: (input: {
    draftKey: string;
    lifecycle: DraftLifecycleState;
  }) => void;
  clearDraftInput: (input: {
    draftKey: string;
    lifecycle?: Exclude<DraftLifecycleState, "active">;
  }) => void;
  getCreateModalDraft: () => DraftInput | null;
  saveCreateModalDraft: (draft: DraftInput | null) => void;
  beginDraftGeneration: (draftKey: string) => number;
  isDraftGenerationCurrent: (input: {
    draftKey: string;
    generation: number;
  }) => boolean;
  collectActiveAttachmentIds: () => string[];
}

type DraftStore = DraftStoreState & DraftStoreActions;

const draftGenerations = new Map<string, number>();
let gcScheduled = false;

function createDraftRecord(input: {
  draft: { text: string; images: PersistedDraftImage[] };
  lifecycle: DraftLifecycleState;
  previousVersion?: number;
}): DraftRecord {
  const normalizedImages = input.draft.images.map((image) => {
    if (isAttachmentMetadata(image)) {
      return normalizeAttachmentMetadata(image);
    }
    return image;
  });
  return {
    input: {
      text: input.draft.text,
      images: normalizedImages,
    },
    lifecycle: input.lifecycle,
    updatedAt: Date.now(),
    version: (input.previousVersion ?? 0) + 1,
  };
}

function isAttachmentMetadata(value: unknown): value is AttachmentMetadata {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.mimeType === "string" &&
    typeof record.storageType === "string" &&
    typeof record.storageKey === "string" &&
    typeof record.createdAt === "number"
  );
}

function isLegacyDraftImage(value: unknown): value is LegacyDraftImage {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.uri === "string";
}

function normalizeAttachmentMetadata(image: AttachmentMetadata): AttachmentMetadata {
  return {
    id: image.id,
    mimeType: image.mimeType,
    storageType: image.storageType,
    storageKey: image.storageKey,
    createdAt: image.createdAt,
    ...(typeof image.fileName === "string" || image.fileName === null
      ? { fileName: image.fileName }
      : {}),
    ...(typeof image.byteSize === "number" || image.byteSize === null
      ? { byteSize: image.byteSize }
      : {}),
  };
}

function normalizePersistedImage(value: unknown): PersistedDraftImage | null {
  if (isAttachmentMetadata(value)) {
    return normalizeAttachmentMetadata(value);
  }
  if (isLegacyDraftImage(value)) {
    return {
      uri: value.uri,
      ...(value.mimeType ? { mimeType: value.mimeType } : {}),
    };
  }
  return null;
}

function hasLegacyImages(images: readonly PersistedDraftImage[]): boolean {
  return images.some((entry) => !isAttachmentMetadata(entry));
}

function toDraftInputIfReady(record: DraftRecord | null | undefined): DraftInput | undefined {
  if (!record) {
    return undefined;
  }
  if (record.lifecycle !== "active") {
    return undefined;
  }
  if (hasLegacyImages(record.input.images)) {
    return undefined;
  }
  return {
    text: record.input.text,
    images: (record.input.images as AttachmentMetadata[]).map(
      normalizeAttachmentMetadata
    ),
  };
}

function collectReferencedAttachmentIdsFromState(state: DraftStoreState): Set<string> {
  const referencedIds = new Set<string>();

  for (const draftRecord of Object.values(state.drafts)) {
    if (draftRecord.lifecycle !== "active") {
      continue;
    }
    for (const image of draftRecord.input.images) {
      if (isAttachmentMetadata(image)) {
        referencedIds.add(image.id);
      }
    }
  }

  const modalRecord = state.createModalDraft;
  if (modalRecord?.lifecycle === "active") {
    for (const image of modalRecord.input.images) {
      if (isAttachmentMetadata(image)) {
        referencedIds.add(image.id);
      }
    }
  }

  return referencedIds;
}

function pruneFinalizedDraftRecords(input: {
  drafts: Record<string, DraftRecord>;
  nowMs: number;
}): Record<string, DraftRecord> {
  let changed = false;
  const next: Record<string, DraftRecord> = {};
  for (const [draftKey, record] of Object.entries(input.drafts)) {
    if (
      record.lifecycle !== "active" &&
      input.nowMs - record.updatedAt >= FINALIZED_DRAFT_TTL_MS
    ) {
      changed = true;
      continue;
    }
    next[draftKey] = record;
  }
  return changed ? next : input.drafts;
}

function applyClearDraftRecord(input: {
  record: DraftRecord;
  lifecycle?: Exclude<DraftLifecycleState, "active">;
  nowMs: number;
}): DraftRecord | null {
  if (!input.lifecycle) {
    return null;
  }

  return {
    ...input.record,
    input: { text: "", images: [] },
    lifecycle: input.lifecycle,
    updatedAt: input.nowMs,
    version: input.record.version + 1,
  };
}

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

  try {
    const [{ useCreateFlowStore }, { useSessionStore }] = await Promise.all([
      import("@/stores/create-flow-store"),
      import("@/stores/session-store"),
    ]);

    const pendingCreate = useCreateFlowStore.getState().pending;
    if (pendingCreate?.lifecycle === "active" && pendingCreate.images) {
      for (const image of pendingCreate.images) {
        referencedIds.add(image.id);
      }
    }

    const sessions = useSessionStore.getState().sessions;
    for (const session of Object.values(sessions)) {
      for (const queue of session.queuedMessages.values()) {
        for (const queuedMessage of queue) {
          for (const image of queuedMessage.images ?? []) {
            referencedIds.add(image.id);
          }
        }
      }

      for (const stream of session.agentStreamTail.values()) {
        for (const item of stream) {
          if (item.kind !== "user_message") {
            continue;
          }
          for (const image of item.images ?? []) {
            referencedIds.add(image.id);
          }
        }
      }

      for (const stream of session.agentStreamHead.values()) {
        for (const item of stream) {
          if (item.kind !== "user_message") {
            continue;
          }
          for (const image of item.images ?? []) {
            referencedIds.add(image.id);
          }
        }
      }
    }
  } catch (error) {
    console.warn("[DraftStore] Failed to collect attachment GC references", error);
  }

  try {
    await garbageCollectAttachments({ referencedIds });
  } catch (error) {
    console.warn("[DraftStore] Attachment garbage collection failed", error);
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
    .filter(([, record]) => hasLegacyImages(record.input.images))
    .map(([draftKey]) => draftKey);

  for (const draftKey of keys) {
    try {
      await state.hydrateDraftInput(draftKey);
    } catch (error) {
      console.warn("[DraftStore] Failed to migrate draft during startup", {
        draftKey,
        error,
      });
    }
  }
}

async function migrateLegacyImages(images: readonly PersistedDraftImage[]): Promise<AttachmentMetadata[]> {
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
    })
  );

  return migrated.filter((entry): entry is AttachmentMetadata => entry !== null);
}

function migratePersistedState(state: unknown): DraftStoreState {
  const input = (state ?? {}) as {
    drafts?: Record<string, unknown>;
    createModalDraft?: unknown;
  };

  const nextDrafts: Record<string, DraftRecord> = {};
  for (const [draftKey, rawRecord] of Object.entries(input.drafts ?? {})) {
    if (!rawRecord || typeof rawRecord !== "object") {
      continue;
    }
    const parsed = rawRecord as Record<string, unknown>;

    if ("input" in parsed && parsed.input && typeof parsed.input === "object") {
      const recordInput = parsed.input as Record<string, unknown>;
      nextDrafts[draftKey] = {
        input: {
          text: typeof recordInput.text === "string" ? recordInput.text : "",
          images: Array.isArray(recordInput.images)
            ? (recordInput.images
                .map((entry) => normalizePersistedImage(entry))
                .filter((entry): entry is PersistedDraftImage => entry !== null))
            : [],
        },
        lifecycle:
          parsed.lifecycle === "sent" || parsed.lifecycle === "abandoned"
            ? (parsed.lifecycle as DraftLifecycleState)
            : "active",
        updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
        version: typeof parsed.version === "number" ? parsed.version : 1,
      };
      continue;
    }

    // Legacy shape: { text, images }.
    const legacy = parsed as { text?: unknown; images?: unknown };
    nextDrafts[draftKey] = {
      input: {
        text: typeof legacy.text === "string" ? legacy.text : "",
        images: Array.isArray(legacy.images)
          ? (legacy.images
              .map((entry) => normalizePersistedImage(entry))
              .filter((entry): entry is PersistedDraftImage => entry !== null))
          : [],
      },
      lifecycle: "active",
      updatedAt: Date.now(),
      version: 1,
    };
  }

  let createModalDraft: DraftRecord | null = null;
  if (input.createModalDraft && typeof input.createModalDraft === "object") {
    const record = input.createModalDraft as Record<string, unknown>;
    if (record.input && typeof record.input === "object") {
      const recordInput = record.input as Record<string, unknown>;
      createModalDraft = {
        input: {
          text: typeof recordInput.text === "string" ? recordInput.text : "",
          images: Array.isArray(recordInput.images)
            ? (recordInput.images
                .map((entry) => normalizePersistedImage(entry))
                .filter((entry): entry is PersistedDraftImage => entry !== null))
            : [],
        },
        lifecycle:
          record.lifecycle === "sent" || record.lifecycle === "abandoned"
            ? (record.lifecycle as DraftLifecycleState)
            : "active",
        updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : Date.now(),
        version: typeof record.version === "number" ? record.version : 1,
      };
    } else {
      const legacy = record as { text?: unknown; images?: unknown };
      createModalDraft = {
        input: {
          text: typeof legacy.text === "string" ? legacy.text : "",
          images: Array.isArray(legacy.images)
            ? (legacy.images
                .map((entry) => normalizePersistedImage(entry))
                .filter((entry): entry is PersistedDraftImage => entry !== null))
            : [],
        },
        lifecycle: "active",
        updatedAt: Date.now(),
        version: 1,
      };
    }
  }

  return {
    drafts: nextDrafts,
    createModalDraft,
  };
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

      hydrateDraftInput: async (draftKey) => {
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

        const migratedImages = await migrateLegacyImages(current.input.images);
        const migratedDraft: DraftInput = {
          text: current.input.text,
          images: migratedImages,
        };

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
      storage: createJSONStorage(() => AsyncStorage),
      migrate: (persistedState) => {
        return migratePersistedState(persistedState);
      },
      onRehydrateStorage: () => {
        return () => {
          void migrateAllLegacyDrafts();
          scheduleAttachmentGc();
        };
      },
    }
  )
);

export const __draftStoreTestUtils = {
  migratePersistedState,
  normalizeAttachmentMetadata,
  pruneFinalizedDraftRecords,
  applyClearDraftRecord,
};

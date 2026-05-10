import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { AttachmentMetadata, UserComposerAttachment } from "@/attachments/types";
import { GitHubSearchItemSchema } from "@server/shared/messages";
import {
  garbageCollectAttachments,
  persistAttachmentFromDataUrl,
  persistAttachmentFromFileUri,
} from "@/attachments/service";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import { useSessionStore, type SessionState } from "@/stores/session-store";

const DRAFT_STORE_VERSION = 4;
const FINALIZED_DRAFT_TTL_MS = 5 * 60 * 1000;

interface LegacyDraftImage {
  uri: string;
  mimeType?: string;
}

type PersistedDraftImage = AttachmentMetadata | LegacyDraftImage;

export interface DraftInput {
  text: string;
  attachments: UserComposerAttachment[];
}

export type DraftLifecycleState = "active" | "abandoned" | "sent";

type CanonicalDraftInput = DraftInput;

interface DraftRecord {
  input: CanonicalDraftInput;
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

function isUserComposerAttachment(value: unknown): value is UserComposerAttachment {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "image") {
    const metadata = record.metadata;
    return isAttachmentMetadata(metadata);
  }
  if (record.kind !== "github_issue" && record.kind !== "github_pr") {
    return false;
  }
  return GitHubSearchItemSchema.safeParse(record.item).success;
}

function normalizeComposerAttachment(attachment: UserComposerAttachment): UserComposerAttachment {
  if (attachment.kind === "image") {
    return {
      kind: "image",
      metadata: normalizeAttachmentMetadata(attachment.metadata),
    };
  }
  return attachment;
}

function normalizePersistedComposerAttachment(value: unknown): UserComposerAttachment | null {
  if (!isUserComposerAttachment(value)) {
    return null;
  }
  return normalizeComposerAttachment(value);
}

function legacyImagesToAttachments(
  images: readonly AttachmentMetadata[],
): UserComposerAttachment[] {
  return images.map((metadata) => ({
    kind: "image",
    metadata,
  }));
}

function isCanonicalDraftInput(value: unknown): value is CanonicalDraftInput {
  if (!value || typeof value !== "object") {
    return false;
  }
  const input = value as Record<string, unknown>;
  // COMPAT(draft-cwd): accept legacy persisted drafts that include cwd. Stop accepting after 2026-11-09.
  return (
    typeof input.text === "string" &&
    Array.isArray(input.attachments) &&
    input.attachments.every(isUserComposerAttachment)
  );
}

function toDraftInputIfReady(record: DraftRecord | null | undefined): DraftInput | undefined {
  if (!record) {
    return undefined;
  }
  if (record.lifecycle !== "active") {
    return undefined;
  }
  if (!isCanonicalDraftInput(record.input)) {
    return undefined;
  }
  return {
    text: record.input.text,
    attachments: record.input.attachments.map(normalizeComposerAttachment),
  };
}

function collectReferencedAttachmentIdsFromState(state: DraftStoreState): Set<string> {
  const referencedIds = new Set<string>();

  for (const draftRecord of Object.values(state.drafts)) {
    if (draftRecord.lifecycle !== "active") {
      continue;
    }
    if (!isCanonicalDraftInput(draftRecord.input)) {
      continue;
    }
    for (const attachment of draftRecord.input.attachments) {
      if (attachment.kind === "image") {
        referencedIds.add(attachment.metadata.id);
      }
    }
  }

  const modalRecord = state.createModalDraft;
  if (modalRecord?.lifecycle === "active" && isCanonicalDraftInput(modalRecord.input)) {
    for (const attachment of modalRecord.input.attachments) {
      if (attachment.kind === "image") {
        referencedIds.add(attachment.metadata.id);
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
    if (record.lifecycle !== "active" && input.nowMs - record.updatedAt >= FINALIZED_DRAFT_TTL_MS) {
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
    input: { text: "", attachments: [] },
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

async function migrateLegacyImages(
  images: readonly PersistedDraftImage[],
): Promise<AttachmentMetadata[]> {
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
}

async function migrateDraftInput(input: { rawInput: unknown }): Promise<CanonicalDraftInput> {
  const rawInput =
    input.rawInput && typeof input.rawInput === "object"
      ? (input.rawInput as Record<string, unknown>)
      : {};
  const attachments = Array.isArray(rawInput.attachments)
    ? rawInput.attachments
        .map((entry) => normalizePersistedComposerAttachment(entry))
        .filter((entry): entry is UserComposerAttachment => entry !== null)
    : [];
  const legacyImages = Array.isArray(rawInput.images)
    ? rawInput.images
        .map((entry) => normalizePersistedImage(entry))
        .filter((entry): entry is PersistedDraftImage => entry !== null)
    : [];
  const migratedImages = await migrateLegacyImages(legacyImages);

  return {
    text: typeof rawInput.text === "string" ? rawInput.text : "",
    attachments: [...attachments, ...legacyImagesToAttachments(migratedImages)],
  };
}

function resolvePersistedLifecycle(lifecycle: unknown): DraftLifecycleState {
  if (lifecycle === "sent" || lifecycle === "abandoned") {
    return lifecycle as DraftLifecycleState;
  }
  return "active";
}

function extractRawInput(record: Record<string, unknown>): unknown {
  if ("input" in record && record.input && typeof record.input === "object") {
    return record.input;
  }
  return record;
}

async function buildMigratedDraftRecord(parsed: Record<string, unknown>): Promise<DraftRecord> {
  return {
    input: await migrateDraftInput({ rawInput: extractRawInput(parsed) }),
    lifecycle: resolvePersistedLifecycle(parsed.lifecycle),
    updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
    version: typeof parsed.version === "number" ? parsed.version : 1,
  };
}

async function migratePersistedState(state: unknown): Promise<DraftStoreState> {
  const input = (state ?? {}) as {
    drafts?: Record<string, unknown>;
    createModalDraft?: unknown;
  };

  const nextDrafts: Record<string, DraftRecord> = {};
  for (const [draftKey, rawRecord] of Object.entries(input.drafts ?? {})) {
    if (!rawRecord || typeof rawRecord !== "object") {
      continue;
    }
    nextDrafts[draftKey] = await buildMigratedDraftRecord(rawRecord as Record<string, unknown>);
  }

  let createModalDraft: DraftRecord | null = null;
  if (input.createModalDraft && typeof input.createModalDraft === "object") {
    createModalDraft = await buildMigratedDraftRecord(
      input.createModalDraft as Record<string, unknown>,
    );
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

        const migratedDraft = await migrateDraftInput({
          rawInput: current.input,
        });

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
    },
  ),
);

export const __draftStoreTestUtils = {
  migrateDraftInput,
  migratePersistedState,
  normalizeAttachmentMetadata,
  pruneFinalizedDraftRecords,
  applyClearDraftRecord,
};

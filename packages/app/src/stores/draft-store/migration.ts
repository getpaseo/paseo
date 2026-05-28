import type { AttachmentMetadata, UserComposerAttachment } from "@/attachments/types";
import {
  isAttachmentMetadata,
  isLegacyDraftImage,
  isUserComposerAttachment,
  normalizeAttachmentMetadata,
  normalizeComposerAttachment,
  type CanonicalDraftInput,
  type DraftLifecycleState,
  type DraftRecord,
  type DraftStoreState,
  type PersistedDraftImage,
} from "./state";

export type MigrateLegacyImages = (
  images: readonly PersistedDraftImage[],
) => Promise<AttachmentMetadata[]>;

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

export async function migrateDraftInput(
  input: { rawInput: unknown },
  ports: { migrateLegacyImages: MigrateLegacyImages },
): Promise<CanonicalDraftInput> {
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
  const migratedImages = await ports.migrateLegacyImages(legacyImages);

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

async function buildMigratedDraftRecord(
  parsed: Record<string, unknown>,
  ports: { migrateLegacyImages: MigrateLegacyImages },
  nowMs: number,
): Promise<DraftRecord> {
  return {
    input: await migrateDraftInput({ rawInput: extractRawInput(parsed) }, ports),
    lifecycle: resolvePersistedLifecycle(parsed.lifecycle),
    updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : nowMs,
    version: typeof parsed.version === "number" ? parsed.version : 1,
  };
}

export async function migratePersistedState(
  state: unknown,
  ports: { migrateLegacyImages: MigrateLegacyImages; nowMs: number },
): Promise<DraftStoreState> {
  const input = (state ?? {}) as {
    drafts?: Record<string, unknown>;
    createModalDraft?: unknown;
  };

  const nextDrafts: Record<string, DraftRecord> = {};
  for (const [draftKey, rawRecord] of Object.entries(input.drafts ?? {})) {
    if (!rawRecord || typeof rawRecord !== "object") {
      continue;
    }
    nextDrafts[draftKey] = await buildMigratedDraftRecord(
      rawRecord as Record<string, unknown>,
      ports,
      ports.nowMs,
    );
  }

  let createModalDraft: DraftRecord | null = null;
  if (input.createModalDraft && typeof input.createModalDraft === "object") {
    createModalDraft = await buildMigratedDraftRecord(
      input.createModalDraft as Record<string, unknown>,
      ports,
      ports.nowMs,
    );
  }

  return {
    drafts: nextDrafts,
    createModalDraft,
  };
}

import type { AttachmentMetadata, UserComposerAttachment } from "@/attachments/types";
import { GitHubSearchItemSchema } from "@getpaseo/protocol/messages";

export const DRAFT_STORE_VERSION = 4;
export const FINALIZED_DRAFT_TTL_MS = 5 * 60 * 1000;

export interface LegacyDraftImage {
  uri: string;
  mimeType?: string;
}

export type PersistedDraftImage = AttachmentMetadata | LegacyDraftImage;

export interface DraftInput {
  text: string;
  attachments: UserComposerAttachment[];
}

export type DraftLifecycleState = "active" | "abandoned" | "sent";

export type CanonicalDraftInput = DraftInput;

export interface DraftRecord {
  input: CanonicalDraftInput;
  lifecycle: DraftLifecycleState;
  updatedAt: number;
  version: number;
}

export interface DraftStoreState {
  drafts: Record<string, DraftRecord>;
  createModalDraft: DraftRecord | null;
}

export type MigrateLegacyImages = (
  images: readonly PersistedDraftImage[],
) => Promise<AttachmentMetadata[]>;

export function isAttachmentMetadata(value: unknown): value is AttachmentMetadata {
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

export function isLegacyDraftImage(value: unknown): value is LegacyDraftImage {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.uri === "string";
}

export function normalizeAttachmentMetadata(image: AttachmentMetadata): AttachmentMetadata {
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

export function normalizePersistedImage(value: unknown): PersistedDraftImage | null {
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

export function isUserComposerAttachment(value: unknown): value is UserComposerAttachment {
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

export function normalizeComposerAttachment(
  attachment: UserComposerAttachment,
): UserComposerAttachment {
  if (attachment.kind === "image") {
    return {
      kind: "image",
      metadata: normalizeAttachmentMetadata(attachment.metadata),
    };
  }
  return attachment;
}

export function normalizePersistedComposerAttachment(
  value: unknown,
): UserComposerAttachment | null {
  if (!isUserComposerAttachment(value)) {
    return null;
  }
  return normalizeComposerAttachment(value);
}

export function legacyImagesToAttachments(
  images: readonly AttachmentMetadata[],
): UserComposerAttachment[] {
  return images.map((metadata) => ({
    kind: "image",
    metadata,
  }));
}

export function isCanonicalDraftInput(value: unknown): value is CanonicalDraftInput {
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

export function toDraftInputIfReady(
  record: DraftRecord | null | undefined,
): DraftInput | undefined {
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

export function collectReferencedAttachmentIdsFromState(state: DraftStoreState): Set<string> {
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

export function pruneFinalizedDraftRecords(input: {
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

export function applyClearDraftRecord(input: {
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

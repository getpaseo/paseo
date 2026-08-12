import type { AttachmentMetadata, UserComposerAttachment } from "@/attachments/types";
import { isLegacyNewWorkspaceDraftKey, NEW_WORKSPACE_DRAFT_KEY } from "@/stores/draft-keys";
import { z } from "zod";
import {
  AttachmentMetadataSchema,
  LegacyDraftImageSchema,
  normalizeAttachmentMetadata,
  normalizeComposerAttachment,
  UserComposerAttachmentSchema,
  type CanonicalDraftInput,
  type DraftLifecycleState,
  type DraftRecord,
  type DraftStoreState,
  type PersistedDraftImage,
} from "./state";

const LegacyPullRequestItemSchema = z.strictObject({
  kind: z.literal("pr"),
  forge: z.string().optional(),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.string(),
  body: z.string().nullable(),
  labels: z.array(z.string()),
  projectPath: z.string().optional(),
  baseRefName: z.string().nullable().optional(),
  headRefName: z.string().nullable().optional(),
  updatedAt: z.string().optional(),
});
const LegacyGithubPrAttachmentSchema = z.strictObject({
  kind: z.literal("github_pr"),
  item: LegacyPullRequestItemSchema,
  owner: z.literal("new-workspace-picker").optional(),
});
const PersistedComposerAttachmentSchema = z.union([
  UserComposerAttachmentSchema,
  LegacyGithubPrAttachmentSchema,
]);
type PersistedComposerAttachment = z.infer<typeof PersistedComposerAttachmentSchema>;
const LegacyAttachmentMetadataSchema = AttachmentMetadataSchema.extend({
  previewUri: z.string(),
});
type PersistedImage = PersistedDraftImage | z.infer<typeof LegacyAttachmentMetadataSchema>;

const RawDraftInputSchema = z.strictObject({
  text: z.string().optional(),
  attachments: z.array(PersistedComposerAttachmentSchema).optional(),
  images: z
    .array(
      z.union([AttachmentMetadataSchema, LegacyAttachmentMetadataSchema, LegacyDraftImageSchema]),
    )
    .optional(),
  cwd: z.string().optional(),
});
const DraftLifecycleSchema = z.enum(["active", "abandoned", "sent"]);
const NestedDraftRecordSchema = z.strictObject({
  input: RawDraftInputSchema,
  lifecycle: DraftLifecycleSchema.optional(),
  updatedAt: z.number().optional(),
  version: z.number().int().positive().optional(),
});
const FlatDraftRecordSchema = RawDraftInputSchema.extend({
  lifecycle: DraftLifecycleSchema.optional(),
  updatedAt: z.number().optional(),
  version: z.number().int().positive().optional(),
});
const PersistedDraftRecordSchema = z.union([NestedDraftRecordSchema, FlatDraftRecordSchema]);
const PersistedDraftStoreSchema = z.strictObject({
  drafts: z.record(z.string(), PersistedDraftRecordSchema).optional(),
  createModalDraft: PersistedDraftRecordSchema.nullable().optional(),
});
type PersistedDraftRecord = z.infer<typeof PersistedDraftRecordSchema>;

export type MigrateLegacyImages = (
  images: readonly PersistedDraftImage[],
) => Promise<AttachmentMetadata[]>;

function normalizePersistedImage(value: PersistedImage): PersistedDraftImage {
  if ("id" in value) {
    return normalizeAttachmentMetadata(value);
  }
  return {
    uri: value.uri,
    ...(value.mimeType ? { mimeType: value.mimeType } : {}),
  };
}

function legacyImagesToAttachments(
  images: readonly AttachmentMetadata[],
): UserComposerAttachment[] {
  return images.map((metadata) => ({
    kind: "image",
    metadata,
  }));
}

function normalizePersistedComposerAttachment(
  attachment: PersistedComposerAttachment,
): UserComposerAttachment {
  if (attachment.kind === "github_pr" && attachment.item.kind === "pr") {
    return {
      kind: "github_pr",
      item: { ...attachment.item, kind: "change_request" },
      ...(attachment.owner ? { owner: attachment.owner } : {}),
    };
  }
  const result = UserComposerAttachmentSchema.safeParse(attachment);
  if (!result.success) {
    throw new Error("Persisted composer attachment failed validation after migration");
  }
  return normalizeComposerAttachment(result.data);
}

export async function migrateDraftInput(
  input: { rawInput: unknown },
  ports: { migrateLegacyImages: MigrateLegacyImages },
): Promise<CanonicalDraftInput> {
  const result = RawDraftInputSchema.safeParse(input.rawInput);
  const rawInput = result.success ? result.data : {};
  const attachments = (rawInput.attachments ?? []).map(normalizePersistedComposerAttachment);
  const legacyImages = (rawInput.images ?? []).map(normalizePersistedImage);
  const migratedImages = await ports.migrateLegacyImages(legacyImages);

  return {
    text: typeof rawInput.text === "string" ? rawInput.text : "",
    attachments: [...attachments, ...legacyImagesToAttachments(migratedImages)],
  };
}

function resolvePersistedLifecycle(
  lifecycle: DraftLifecycleState | undefined,
): DraftLifecycleState {
  return lifecycle ?? "active";
}

function extractRawInput(record: PersistedDraftRecord): z.infer<typeof RawDraftInputSchema> {
  if ("input" in record) {
    return record.input;
  }
  return record;
}

async function buildMigratedDraftRecord(
  parsed: PersistedDraftRecord,
  ports: { migrateLegacyImages: MigrateLegacyImages },
  nowMs: number,
): Promise<DraftRecord> {
  return {
    input: await migrateDraftInput({ rawInput: extractRawInput(parsed) }, ports),
    lifecycle: resolvePersistedLifecycle(parsed.lifecycle),
    updatedAt: parsed.updatedAt ?? nowMs,
    version: parsed.version ?? 1,
  };
}

function migrateNewWorkspaceDraftKeys(
  drafts: Record<string, DraftRecord>,
): Record<string, DraftRecord> {
  const legacyEntries = Object.entries(drafts).filter(([draftKey]) =>
    isLegacyNewWorkspaceDraftKey(draftKey),
  );
  if (legacyEntries.length === 0) {
    return drafts;
  }

  const nextDrafts = { ...drafts };
  for (const [draftKey] of legacyEntries) {
    delete nextDrafts[draftKey];
  }

  if (nextDrafts[NEW_WORKSPACE_DRAFT_KEY]) {
    return nextDrafts;
  }

  const newestActiveDraft = legacyEntries
    .map(([, draft]) => draft)
    .filter((draft) => draft.lifecycle === "active")
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];
  if (newestActiveDraft) {
    // Legacy scoped drafts did not record whether a PR came from the Base
    // picker. That checkout context is unsafe to carry onto a global surface.
    nextDrafts[NEW_WORKSPACE_DRAFT_KEY] = {
      ...newestActiveDraft,
      input: {
        ...newestActiveDraft.input,
        attachments: newestActiveDraft.input.attachments.filter(
          (attachment) => attachment.kind !== "github_pr",
        ),
      },
    };
  }

  return nextDrafts;
}

export async function migratePersistedState(
  state: unknown,
  ports: { migrateLegacyImages: MigrateLegacyImages; nowMs: number },
): Promise<DraftStoreState> {
  const result = PersistedDraftStoreSchema.safeParse(state);
  const input = result.success ? result.data : {};

  const nextDrafts: Record<string, DraftRecord> = {};
  for (const [draftKey, rawRecord] of Object.entries(input.drafts ?? {})) {
    nextDrafts[draftKey] = await buildMigratedDraftRecord(rawRecord, ports, ports.nowMs);
  }

  let createModalDraft: DraftRecord | null = null;
  if (input.createModalDraft) {
    createModalDraft = await buildMigratedDraftRecord(input.createModalDraft, ports, ports.nowMs);
  }

  return {
    // COMPAT(newWorkspaceDraftSingleton): migrated in v0.1.108; remove after 2027-01-13.
    drafts: migrateNewWorkspaceDraftKeys(nextDrafts),
    createModalDraft,
  };
}

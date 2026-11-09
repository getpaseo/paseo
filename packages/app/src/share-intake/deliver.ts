import type { AttachmentMetadata, UserComposerAttachment } from "@/attachments/types";
import { buildDraftStoreKey, generateDraftId } from "@/stores/draft-keys";
import type { DraftInput } from "@/stores/draft-store/state";
import type { IncomingShare, SharedFile } from "./model";

/** Where the user sends a share: into an agent's composer, or a new agent draft in a workspace. */
export type ShareTarget =
  | { kind: "agent"; serverId: string; agentId: string }
  | { kind: "workspace"; serverId: string; workspaceId: string };

type FileAttachment = Extract<UserComposerAttachment, { kind: "file" }>;

export interface DeliverShareDeps {
  /** Images stay on this device and travel inline when the message is sent. */
  rasterImageMimeType(file: SharedFile): string | null;
  persistImage(file: SharedFile, mimeType: string): Promise<AttachmentMetadata>;
  /** Keeps a persisted image from garbage collection until a draft references it. */
  retainImage(attachmentId: string): () => void;
  /** Other files upload to the target's host, so they belong to that host. */
  uploadFiles(serverId: string, files: SharedFile[]): Promise<FileAttachment[]>;
  appendDraftInput(input: { draftKey: string; addition: DraftInput }): Promise<void>;
  openAgent(input: { serverId: string; agentId: string }): void;
  openWorkspaceDraft(input: { serverId: string; workspaceId: string; draftId: string }): void;
}

/**
 * Adds the share to the target's composer and opens it. Nothing is sent: the user reads the draft,
 * adds a prompt, and sends it themselves. Attachments keep the order the sending app gave them.
 */
export async function deliverShare(
  share: IncomingShare,
  target: ShareTarget,
  deps: DeliverShareDeps,
): Promise<void> {
  const releases: Array<() => void> = [];
  try {
    const attachments = await buildAttachments(share.files, target.serverId, deps, releases);
    const addition: DraftInput = { text: share.text, attachments };
    if (target.kind === "agent") {
      await deps.appendDraftInput({
        draftKey: buildDraftStoreKey({ serverId: target.serverId, agentId: target.agentId }),
        addition,
      });
      deps.openAgent({ serverId: target.serverId, agentId: target.agentId });
      return;
    }
    const draftId = generateDraftId();
    await deps.appendDraftInput({
      // A draft tab's composer keys on the draft id alone; the agent id is a placeholder.
      draftKey: buildDraftStoreKey({ serverId: target.serverId, agentId: draftId, draftId }),
      addition,
    });
    deps.openWorkspaceDraft({
      serverId: target.serverId,
      workspaceId: target.workspaceId,
      draftId,
    });
  } finally {
    for (const release of releases) release();
  }
}

async function buildAttachments(
  files: readonly SharedFile[],
  serverId: string,
  deps: DeliverShareDeps,
  releases: Array<() => void>,
): Promise<UserComposerAttachment[]> {
  const imageMimeTypes = files.map((file) => deps.rasterImageMimeType(file));
  const uploadable = files.filter((_, index) => imageMimeTypes[index] === null);
  // Upload first: it checks every file's size before sending any, and fails without a host.
  const uploaded = uploadable.length > 0 ? await deps.uploadFiles(serverId, uploadable) : [];
  const attachments: UserComposerAttachment[] = [];
  let uploadedIndex = 0;
  for (const [index, file] of files.entries()) {
    const imageMimeType = imageMimeTypes[index];
    if (imageMimeType === null || imageMimeType === undefined) {
      const attachment = uploaded[uploadedIndex++];
      if (attachment) attachments.push(attachment);
      continue;
    }
    const metadata = await deps.persistImage(file, imageMimeType);
    releases.push(deps.retainImage(metadata.id));
    attachments.push({ kind: "image", metadata });
  }
  return attachments;
}

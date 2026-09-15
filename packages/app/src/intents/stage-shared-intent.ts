import type { UserComposerAttachment } from "@/attachments/types";
import { persistAttachmentFromFileUri } from "@/attachments/service";
import { NEW_WORKSPACE_DRAFT_KEY } from "@/stores/draft-keys";
import { buildNewWorkspaceRoute } from "@/utils/host-routes";
import { stagePendingPrompt } from "./pending-prompt-store";
import {
  buildSharedPromptText,
  isImageFile,
  type SharedIntentPayload,
} from "./shared-intent-payload";

export interface StagedSharedIntent {
  route: ReturnType<typeof buildNewWorkspaceRoute>;
  skippedFiles: number;
}

/**
 * Shares always land on the New workspace composer: it is the one surface
 * that exists before a host or workspace is chosen, and its draft survives
 * until the user picks where the prompt goes.
 */
export async function stageSharedIntent(
  payload: SharedIntentPayload,
): Promise<StagedSharedIntent | null> {
  const text = buildSharedPromptText(payload);
  const attachments: UserComposerAttachment[] = [];
  let skippedFiles = payload.kind === "share" ? payload.skippedFiles : 0;

  if (payload.kind === "share") {
    for (const file of payload.files) {
      if (!isImageFile(file)) {
        skippedFiles += 1;
        continue;
      }
      try {
        const metadata = await persistAttachmentFromFileUri({
          uri: file.uri,
          mimeType: file.mimeType,
          fileName: file.fileName ?? null,
        });
        attachments.push({ kind: "image", metadata });
      } catch (error) {
        console.warn("[AndroidIntents] Failed to persist a shared image", error);
        skippedFiles += 1;
      }
    }
  }

  if (!text && attachments.length === 0) {
    return null;
  }

  stagePendingPrompt({ draftKey: NEW_WORKSPACE_DRAFT_KEY, prompt: { text, attachments } });
  return { route: buildNewWorkspaceRoute(), skippedFiles };
}

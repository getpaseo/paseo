import type { UserComposerAttachment } from "@/attachments/types";
import * as FileSystem from "expo-file-system/legacy";
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

function stagedImageDirectory(uri: string): string | null {
  const prefix =
    FileSystem.cacheDirectory && `${FileSystem.cacheDirectory.replace(/\/?$/, "/")}shared-intents/`;
  if (!prefix || !uri.startsWith(prefix)) return null;
  const relative = uri.slice(prefix.length);
  const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/[^/]+$/i.exec(
    relative,
  );
  return match ? `${prefix}${match[1]}/` : null;
}

async function removeStagedImage(uri: string): Promise<void> {
  const directory = stagedImageDirectory(uri);
  if (!directory) return;
  try {
    await FileSystem.deleteAsync(directory, { idempotent: true });
  } catch (error) {
    console.warn("[AndroidIntents] Failed to remove a staged shared image", error);
  }
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
      } finally {
        await removeStagedImage(file.uri);
      }
    }
  }

  if (!text && attachments.length === 0) {
    return null;
  }

  stagePendingPrompt({ draftKey: NEW_WORKSPACE_DRAFT_KEY, prompt: { text, attachments } });
  return { route: buildNewWorkspaceRoute(), skippedFiles };
}

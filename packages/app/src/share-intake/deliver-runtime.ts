import { retainAttachmentForGarbageCollection } from "@/attachments/gc-retention";
import { resolveRasterImageMimeType } from "@/attachments/file-types";
import { persistAttachmentFromFileUri } from "@/attachments/service";
import { uploadFileAttachments } from "@/composer/actions";
import { normalizePickedImageAssets } from "@/hooks/image-attachment-picker";
import { i18n } from "@/i18n/i18next";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useDraftStore } from "@/stores/draft-store";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import type { DeliverShareDeps } from "./deliver";
import { readSharedFileBytes } from "./source";

export const deliverShareRuntime: DeliverShareDeps = {
  rasterImageMimeType: (file) =>
    resolveRasterImageMimeType({ mimeType: file.mimeType, path: file.name }),
  persistImage: async (file, mimeType) => {
    // HEIC, WebP and other formats agents can't read become PNG, as they do from the photo picker.
    const [image] = await normalizePickedImageAssets([
      { uri: file.uri, mimeType, fileName: file.name },
    ]);
    if (!image || image.source.kind !== "file_uri") {
      throw new Error(i18n.t("shareIntake.deliverFailed"));
    }
    return await persistAttachmentFromFileUri({
      uri: image.source.uri,
      mimeType: image.mimeType,
      fileName: image.fileName ?? file.name,
    });
  },
  retainImage: retainAttachmentForGarbageCollection,
  uploadFiles: async (serverId, files) => {
    const client = getHostRuntimeStore().getClient(serverId);
    if (!client) throw new Error(i18n.t("composer.errors.daemonClientDisconnected"));
    return await uploadFileAttachments({
      client,
      files: files.map((file) => ({
        fileName: file.name,
        mimeType: file.mimeType,
        readBytes: () => readSharedFileBytes(file),
      })),
    });
  },
  appendDraftInput: (input) => useDraftStore.getState().appendDraftInput(input),
  openAgent: (input) => {
    navigateToAgent(input);
  },
  openWorkspaceDraft: ({ serverId, workspaceId, draftId }) => {
    navigateToWorkspace({ serverId, workspaceId, target: { kind: "draft", draftId } });
  },
};

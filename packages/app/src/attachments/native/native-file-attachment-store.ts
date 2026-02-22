import { createLocalFileAttachmentStore } from "@/attachments/local-file-attachment-store";

export function createNativeFileAttachmentStore() {
  return createLocalFileAttachmentStore({
    storageType: "native-file",
    baseDirectoryName: "paseo-native-attachments",
    resolvePreviewUrl: async (attachment) => {
      if (attachment.storageKey.startsWith("file://")) {
        return attachment.storageKey;
      }
      if (attachment.storageKey.startsWith("/")) {
        return `file://${attachment.storageKey}`;
      }
      return attachment.storageKey;
    },
  });
}

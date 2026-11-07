import type { AttachmentMetadata } from "@/attachments/types";
import { retainAttachmentForGarbageCollection } from "@/attachments/gc-retention";
import { releaseAttachmentPreviewUrl } from "@/attachments/service";
import { createAssistantImageAcquisitionCache } from "./acquisition-cache";

export interface AssistantImagePreview {
  attachment: AttachmentMetadata;
  uri: string;
}

// Markdown images and timeline image pills resolve to the same acquisition key
// (createAssistantImageFileAcquisitionKey), so they share one cache and one copy
// of the retention rule: hold the preview attachment against garbage collection
// while any consumer holds it, and release its preview URL when the last leaves.
export const assistantImagePreviews = createAssistantImageAcquisitionCache<AssistantImagePreview>({
  capacity: 500,
  onRetain: ({ uri, attachment }) => {
    const release = retainAttachmentForGarbageCollection(attachment.id);
    return () => {
      release();
      void releaseAttachmentPreviewUrl({ attachment, url: uri });
    };
  },
});

import { useEffect, useRef, useState } from "react";
import type { AttachmentMetadata } from "@/attachments/types";
import {
  releaseAttachmentPreviewUrl,
  resolveAttachmentPreviewUrl,
} from "@/attachments/service";

export function useAttachmentPreviewUrl(
  attachment: AttachmentMetadata | null | undefined
): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const activeAttachmentRef = useRef<AttachmentMetadata | null>(null);

  useEffect(() => {
    let disposed = false;
    let currentUrl: string | null = null;

    activeAttachmentRef.current = attachment ?? null;
    if (!attachment) {
      setUrl(null);
      return;
    }

    void (async () => {
      try {
        const resolved = await resolveAttachmentPreviewUrl(attachment);
        if (disposed) {
          await releaseAttachmentPreviewUrl({ attachment, url: resolved });
          return;
        }
        currentUrl = resolved;
        setUrl(resolved);
      } catch (error) {
        console.error("[attachments] Failed to resolve preview URL", {
          attachmentId: attachment.id,
          error,
        });
        if (!disposed) {
          setUrl(null);
        }
      }
    })();

    return () => {
      disposed = true;
      const activeAttachment = activeAttachmentRef.current;
      if (!currentUrl || !activeAttachment) {
        return;
      }
      void releaseAttachmentPreviewUrl({
        attachment: activeAttachment,
        url: currentUrl,
      });
    };
  }, [
    attachment?.id,
    attachment?.storageType,
    attachment?.storageKey,
    attachment?.mimeType,
  ]);

  return url;
}

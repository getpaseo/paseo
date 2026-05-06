import { useEffect, useRef, useState } from "react";
import type { AttachmentMetadata } from "@/attachments/types";
import { releaseAttachmentPreviewUrl, resolveAttachmentPreviewUrl } from "@/attachments/service";

export function useAttachmentPreviewUrl(
  attachment: AttachmentMetadata | null | undefined,
): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const activeAttachmentRef = useRef<AttachmentMetadata | null>(null);
  const attachmentRef = useRef(attachment);
  attachmentRef.current = attachment;

  const id = attachment?.id;
  const storageType = attachment?.storageType;
  const storageKey = attachment?.storageKey;
  const mimeType = attachment?.mimeType;

  useEffect(() => {
    let disposed = false;
    let currentUrl: string | null = null;
    const current = attachmentRef.current;

    activeAttachmentRef.current = current ?? null;
    if (!current) {
      setUrl(null);
      return;
    }

    void (async () => {
      try {
        const resolved = await resolveAttachmentPreviewUrl(current);
        if (disposed) {
          await releaseAttachmentPreviewUrl({ attachment: current, url: resolved });
          return;
        }
        currentUrl = resolved;
        setUrl(resolved);
      } catch (error) {
        console.error("[attachments] Failed to resolve preview URL", {
          attachmentId: current.id,
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
  }, [id, storageType, storageKey, mimeType]);

  return url;
}

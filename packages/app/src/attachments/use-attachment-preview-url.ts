import { useEffect, useRef, useState } from "react";
import type { AttachmentMetadata } from "@/attachments/types";
import { releaseAttachmentPreviewUrl, resolveAttachmentPreviewUrl } from "@/attachments/service";

export type AttachmentPreviewUrl =
  | { status: "loading" }
  | { status: "ready"; url: string }
  | { status: "failed" };

const LOADING: AttachmentPreviewUrl = { status: "loading" };
const FAILED: AttachmentPreviewUrl = { status: "failed" };

function attachmentKey(attachment: AttachmentMetadata | null | undefined): string | null {
  if (!attachment) return null;
  return [attachment.id, attachment.storageType, attachment.storageKey, attachment.mimeType].join(
    "\u0000",
  );
}

/**
 * Resolves a displayable URL for a stored attachment. Stays `loading` until the URL for the
 * current attachment resolves, so a caller never shows a failure, or the previous attachment's
 * URL, while the next one is still resolving. A missing attachment stays `loading`.
 */
export function useAttachmentPreviewUrl(
  attachment: AttachmentMetadata | null | undefined,
): AttachmentPreviewUrl {
  const [resolved, setResolved] = useState<{
    key: string;
    preview: AttachmentPreviewUrl;
  } | null>(null);
  const attachmentRef = useRef(attachment);
  attachmentRef.current = attachment;
  const key = attachmentKey(attachment);

  useEffect(() => {
    const current = attachmentRef.current;
    if (!current || key === null) {
      return;
    }
    let disposed = false;
    let currentUrl: string | null = null;

    void (async () => {
      try {
        const url = await resolveAttachmentPreviewUrl(current);
        if (disposed) {
          await releaseAttachmentPreviewUrl({ attachment: current, url });
          return;
        }
        currentUrl = url;
        setResolved({ key, preview: { status: "ready", url } });
      } catch (error) {
        console.error("[attachments] Failed to resolve preview URL", {
          attachmentId: current.id,
          error,
        });
        if (!disposed) {
          setResolved({ key, preview: FAILED });
        }
      }
    })();

    return () => {
      disposed = true;
      if (currentUrl) {
        void releaseAttachmentPreviewUrl({ attachment: current, url: currentUrl });
      }
      // A result lives only as long as its lookup. Kept, the same attachment coming back would
      // read a released URL, or an old failure, until the next lookup lands.
      setResolved((previous) => (previous?.key === key ? null : previous));
    };
  }, [key]);

  return resolved !== null && resolved.key === key ? resolved.preview : LOADING;
}

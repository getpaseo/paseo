import { useEffect, useRef, useState } from "react";
import type { AttachmentMetadata } from "@/attachments/types";
import { releaseAttachmentPreviewUrl, resolveAttachmentPreviewUrl } from "@/attachments/service";

export type AttachmentPreviewUrlState =
  | { status: "idle" | "loading" | "error"; url: null }
  | { status: "ready"; url: string };

export async function resolveAttachmentPreviewUrlState(input: {
  attachment: AttachmentMetadata;
  resolve: (attachment: AttachmentMetadata) => Promise<string>;
}): Promise<{ status: "ready"; url: string } | { status: "error"; url: null }> {
  try {
    return { status: "ready", url: await input.resolve(input.attachment) };
  } catch {
    return { status: "error", url: null };
  }
}

export function useAttachmentPreviewUrlState(
  attachment: AttachmentMetadata | null | undefined,
  retryKey = 0,
): AttachmentPreviewUrlState {
  const [state, setState] = useState<AttachmentPreviewUrlState>({ status: "idle", url: null });
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

    if (!current) {
      setState({ status: "idle", url: null });
      return;
    }

    setState({ status: "loading", url: null });
    void (async () => {
      const result = await resolveAttachmentPreviewUrlState({
        attachment: current,
        resolve: resolveAttachmentPreviewUrl,
      });
      if (result.status === "error") {
        console.error("[attachments] Failed to resolve preview URL", {
          attachmentId: current.id,
        });
        if (!disposed) {
          setState(result);
        }
        return;
      }
      if (disposed) {
        await releaseAttachmentPreviewUrl({ attachment: current, url: result.url });
        return;
      }
      currentUrl = result.url;
      setState(result);
    })();

    return () => {
      disposed = true;
      if (!currentUrl) {
        return;
      }
      void releaseAttachmentPreviewUrl({ attachment: current, url: currentUrl });
    };
  }, [id, storageType, storageKey, mimeType, retryKey]);

  return state;
}

export function useAttachmentPreviewUrl(
  attachment: AttachmentMetadata | null | undefined,
): string | null {
  return useAttachmentPreviewUrlState(attachment).url;
}

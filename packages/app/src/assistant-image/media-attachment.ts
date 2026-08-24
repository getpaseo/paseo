import { useEffect, useLayoutEffect, useState } from "react";
import type { AttachmentMetadata } from "@/attachments/types";
import { useStableEvent } from "@/hooks/use-stable-event";
import { retainAttachmentForGarbageCollection } from "@/attachments/gc-retention";
import { releaseAttachmentPreviewUrl, resolveAttachmentPreviewUrl } from "@/attachments/service";
import { createAssistantImageAcquisitionCache } from "./acquisition-cache";
import type { AssistantImageAcquisition } from "./file-acquisition";
import { runAssistantImageOperationWithRetry } from "./retry";

// Getting a timeline attachment onto the screen is the same job for every media
// type: locate the bytes once, keep the result under a key so a remount or a tab
// switch doesn't refetch, then hand out a preview URL with matching lifetime.
// Only the element that consumes the URL differs, so image and video share the
// caches here — the same file referenced twice resolves once.

export type PreviewUrlState =
  | { status: "waiting" }
  | { status: "loading" }
  | { status: "loaded"; uri: string }
  | { status: "failed"; error: unknown };

export type AttachmentAcquisitionState =
  | { status: "waiting" }
  | { status: "loading" }
  | { status: "loaded"; attachment: AttachmentMetadata }
  | { status: "failed"; error: unknown };

const attachmentAcquisitionCache = createAssistantImageAcquisitionCache<AttachmentMetadata>({
  capacity: 500,
  onRetain: (attachment) => retainAttachmentForGarbageCollection(attachment.id),
});

interface CachedPreviewUrl {
  attachment: AttachmentMetadata;
  uri: string;
}

const previewUrlCache = createAssistantImageAcquisitionCache<CachedPreviewUrl>({
  capacity: 500,
  onRetain:
    ({ attachment, uri }) =>
    () => {
      void releaseAttachmentPreviewUrl({ attachment, url: uri });
    },
});

export function useAttachmentAcquisition(
  acquisition: AssistantImageAcquisition | null,
): AttachmentAcquisitionState {
  const acquisitionKey = acquisition?.key ?? null;
  const [entry, setEntry] = useState<{
    key: string | null;
    state: AttachmentAcquisitionState;
  }>(() => {
    const cached = acquisitionKey ? attachmentAcquisitionCache.peek(acquisitionKey) : undefined;
    return {
      key: acquisitionKey,
      state: cached ? { status: "loaded", attachment: cached } : { status: "waiting" },
    };
  });

  useEffect(() => {
    let disposed = false;
    let releaseCurrent: (() => void) | null = null;
    if (!acquisition || !acquisitionKey) {
      setEntry({ key: null, state: { status: "waiting" } });
      return;
    }

    const acquireCurrent = () => {
      releaseCurrent?.();
      const retained = attachmentAcquisitionCache.acquireRetained(
        acquisitionKey,
        acquisition.locate,
      );
      releaseCurrent = retained.release;
      return retained;
    };
    const initial = acquireCurrent();
    if (initial.value) {
      setEntry({ key: acquisitionKey, state: { status: "loaded", attachment: initial.value } });
      return () => {
        disposed = true;
        releaseCurrent?.();
      };
    }

    setEntry({ key: acquisitionKey, state: { status: "loading" } });
    void (async () => {
      let firstAttempt: ReturnType<typeof acquireCurrent> | null = initial;
      try {
        const attachment = await runAssistantImageOperationWithRetry({
          operation: async () => {
            const retained = firstAttempt ?? acquireCurrent();
            firstAttempt = null;
            return await retained.promise;
          },
          shouldStop: () => disposed,
        });
        if (!disposed) {
          setEntry({ key: acquisitionKey, state: { status: "loaded", attachment } });
        }
      } catch (error) {
        if (!disposed) {
          setEntry({ key: acquisitionKey, state: { status: "failed", error } });
        }
      }
    })();
    return () => {
      disposed = true;
      releaseCurrent?.();
    };
  }, [acquisition, acquisitionKey]);

  if (!acquisitionKey) {
    return { status: "waiting" };
  }
  const cached = attachmentAcquisitionCache.peek(acquisitionKey);
  if (cached) {
    return { status: "loaded", attachment: cached };
  }
  return entry.key === acquisitionKey ? entry.state : { status: "waiting" };
}

export function usePreviewUrl(attachment: AttachmentMetadata | null | undefined): PreviewUrlState {
  const id = attachment?.id;
  const storageType = attachment?.storageType;
  const storageKey = attachment?.storageKey;
  const mimeType = attachment?.mimeType;
  const previewKey =
    id && storageType && storageKey && mimeType
      ? `${id}:${storageType}:${storageKey}:${mimeType}`
      : null;
  const [entry, setEntry] = useState<{ key: string | null; state: PreviewUrlState }>(() => {
    return {
      key: previewKey,
      state: { status: "waiting" },
    };
  });
  const getCurrentAttachment = useStableEvent(() => attachment ?? null);

  useLayoutEffect(() => {
    let disposed = false;
    let releaseCurrent: (() => void) | null = null;
    const current = getCurrentAttachment();

    if (!current || !previewKey) {
      setEntry({ key: null, state: { status: "waiting" } });
      return;
    }

    const acquireCurrent = () => {
      releaseCurrent?.();
      const retained = previewUrlCache.acquireRetained(previewKey, async () => ({
        attachment: current,
        uri: await resolveAttachmentPreviewUrl(current),
      }));
      releaseCurrent = retained.release;
      return retained;
    };
    const initial = acquireCurrent();
    if (initial.value) {
      setEntry({ key: previewKey, state: { status: "loaded", uri: initial.value.uri } });
      return () => {
        disposed = true;
        releaseCurrent?.();
      };
    }

    setEntry({ key: previewKey, state: { status: "loading" } });
    void (async () => {
      let firstAttempt: ReturnType<typeof acquireCurrent> | null = initial;
      try {
        const preview = await runAssistantImageOperationWithRetry({
          operation: async () => {
            const retained = firstAttempt ?? acquireCurrent();
            firstAttempt = null;
            return await retained.promise;
          },
          shouldStop: () => disposed,
        });
        if (!disposed) {
          setEntry({ key: previewKey, state: { status: "loaded", uri: preview.uri } });
        }
      } catch (error) {
        if (!disposed) {
          setEntry({ key: previewKey, state: { status: "failed", error } });
        }
      }
    })();

    return () => {
      disposed = true;
      releaseCurrent?.();
    };
  }, [getCurrentAttachment, previewKey]);

  if (!previewKey) {
    return { status: "waiting" };
  }
  return entry.key === previewKey ? entry.state : { status: "waiting" };
}

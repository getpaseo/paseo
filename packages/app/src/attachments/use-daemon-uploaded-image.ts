import { useEffect, useState } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createAssistantImageAcquisitionCache } from "@/assistant-image/acquisition-cache";
import { retainAttachmentForGarbageCollection } from "@/attachments/gc-retention";
import { persistAttachmentFromBytes } from "@/attachments/service";
import type { AttachmentMetadata } from "@/attachments/types";
import { resolveFilePreviewReadTarget } from "@/file-explorer/preview-target";
import type { DaemonUploadedImageAttachment } from "@/types/stream";

const uploadedImageCache = createAssistantImageAcquisitionCache<AttachmentMetadata>({
  capacity: 200,
  onRetain: (attachment) => retainAttachmentForGarbageCollection(attachment.id),
});

function buildCacheKey(serverId: string | undefined, image: DaemonUploadedImageAttachment): string {
  return [serverId ?? "local", image.id, image.path].join("\u0000");
}

function buildLocalAttachmentId(serverId: string | undefined, uploadId: string): string {
  const safeServer = (serverId ?? "local").replace(/[^a-zA-Z0-9_-]/g, "_");
  const safeUpload = uploadId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `daemon-upload-${safeServer}-${safeUpload}`;
}

/**
 * Loads a daemon-stored uploaded image through `client.readFile` (binary chunked stream),
 * persists it into the local attachment store, and retains it in a bounded LRU cache so
 * timeline reloads and cross-device views render thumbnails and lightbox previews cleanly.
 */
export function useDaemonUploadedImage(input: {
  image: DaemonUploadedImageAttachment;
  client?: Pick<DaemonClient, "readFile"> | null;
  serverId?: string;
}): AttachmentMetadata | null {
  const { image, client, serverId } = input;
  const cacheKey = buildCacheKey(serverId, image);
  const [resolved, setResolved] = useState<{ key: string; metadata: AttachmentMetadata } | null>(
    null,
  );

  useEffect(() => {
    if (!client) {
      return;
    }
    const target = resolveFilePreviewReadTarget({ path: image.path });
    if (!target) {
      return;
    }

    let cancelled = false;
    const retained = uploadedImageCache.acquireRetained(cacheKey, async () => {
      const file = await client.readFile(target.cwd, target.path);
      return await persistAttachmentFromBytes({
        id: buildLocalAttachmentId(serverId, image.id),
        bytes: file.bytes,
        mimeType: image.mimeType || file.mime,
        fileName: image.fileName,
      });
    });

    void retained.promise
      .then((metadata) => {
        if (!cancelled) {
          setResolved({ key: cacheKey, metadata });
        }
        return undefined;
      })
      .catch((error) => {
        console.warn("[attachments] Failed to load uploaded user message image", {
          id: image.id,
          path: image.path,
          error,
        });
      });

    return () => {
      cancelled = true;
      retained.release();
    };
  }, [cacheKey, client, image.fileName, image.id, image.mimeType, image.path, serverId]);

  return resolved?.key === cacheKey ? resolved.metadata : null;
}

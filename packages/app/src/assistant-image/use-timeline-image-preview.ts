import { useEffect, useMemo } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { persistAttachmentFromBytes, resolveAttachmentPreviewUrl } from "@/attachments/service";
import { useFetchQuery } from "@/data/query";
import { resolveAssistantImageSource } from "@/utils/assistant-image-source";
import { assistantImagePreviews, type AssistantImagePreview } from "./image-cache";
import { createAssistantImageFileAcquisition } from "./file-acquisition";

export type TimelineImagePreview =
  | { status: "pending"; uri: null }
  | { status: "loaded"; uri: string }
  | { status: "unavailable" | "failed"; uri: null };

export function useTimelineImagePreview(input: {
  source: string;
  occurrenceKey: string;
  client?: Pick<DaemonClient, "readFile"> | null;
  workspaceRoot?: string;
  serverId?: string;
}): TimelineImagePreview {
  const { source, occurrenceKey, client, workspaceRoot, serverId } = input;
  const resolution = useMemo(
    () => resolveAssistantImageSource({ source, workspaceRoot }),
    [source, workspaceRoot],
  );
  // A `direct` source (http, data: or blob:) is already renderable; only a host path needs
  // a file read, so the file acquisition stays null for direct sources.
  const directUri = resolution?.kind === "direct" ? resolution.uri : undefined;
  const acquisition = useMemo(
    () =>
      createAssistantImageFileAcquisition({
        port: client
          ? {
              readFile: (cwd, path) => client.readFile(cwd, path),
              persist: persistAttachmentFromBytes,
            }
          : null,
        resolution,
        serverId,
        occurrenceKey,
        unavailableMessage: "Image unavailable",
      }),
    [client, occurrenceKey, resolution, serverId],
  );

  const result = useFetchQuery<AssistantImagePreview>({
    queryKey: ["timelineImage", acquisition?.key ?? `${occurrenceKey}:${source}`],
    enabled: acquisition !== null,
    immutableWhen: () => true,
    dataShape: "value",
    gcTime: 0,
    queryFn: async () => {
      if (!acquisition) throw new Error("Image unavailable");
      return assistantImagePreviews.acquire(acquisition.key, async () => {
        const attachment = await acquisition.locate();
        const uri = await resolveAttachmentPreviewUrl(attachment);
        return { attachment, uri };
      });
    },
  });

  // Hold the fetched attachment against attachment garbage collection while this preview
  // is mounted, and release its preview URL when it unmounts.
  const value = result.data;
  useEffect(() => {
    if (!acquisition || !value) return;
    return assistantImagePreviews.acquireRetained(acquisition.key, async () => value).release;
  }, [acquisition, value]);

  if (directUri !== undefined) {
    return { status: "loaded", uri: directUri };
  }
  if (!acquisition) {
    return { status: "unavailable", uri: null };
  }
  if (result.isError) {
    return { status: "failed", uri: null };
  }
  return value ? { status: "loaded", uri: value.uri } : { status: "pending", uri: null };
}

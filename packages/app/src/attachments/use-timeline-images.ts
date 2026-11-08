import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { TimelineImage } from "@getpaseo/protocol/timeline-image";
import { useFetchQueries } from "@/data/query";
import { persistAttachmentFromBytes, persistAttachmentFromDataUrl } from "./service";
import { getAttachmentStore } from "./store";
import type { AttachmentMetadata } from "./types";
import { retainAttachmentForGarbageCollection } from "./gc-retention";

export function useTimelineImages(input: {
  client?: DaemonClient | null;
  serverId?: string;
  agentId?: string;
  images: readonly TimelineImage[];
}) {
  const { client, serverId, agentId, images } = input;
  const queryClient = useQueryClient();
  const results = useFetchQueries(
    images.map((image, index) => ({
      queryKey: [
        "timelineImage",
        serverId,
        agentId,
        image.kind === "stored" ? image.id : `unavailable-${index}`,
      ],
      enabled: Boolean(client && agentId && image.kind === "stored"),
      immutableWhen: () => true,
      dataShape: "value" as const,
      gcTime: 0,
      queryFn: async () => {
        if (!client || !agentId || image.kind !== "stored")
          throw new Error("Image connection unavailable");
        const queryKey = ["timelineImageAttachment", serverId, agentId, image.id];
        return queryClient.fetchQuery({
          queryKey,
          gcTime: 5 * 60_000,
          staleTime: 0,
          queryFn: async () => {
            const cached = queryClient.getQueryData<AttachmentMetadata>(queryKey);
            if (cached) {
              const release = retainAttachmentForGarbageCollection(cached.id);
              try {
                const store = await getAttachmentStore();
                let base64: string | undefined;
                try {
                  // Preview URLs on native/desktop do not check whether bytes still exist.
                  base64 = await store.encodeBase64({ attachment: cached });
                } catch {
                  // Unmounted rows are not retained: attachment GC or the OS may remove them.
                }
                if (base64 !== undefined) {
                  // A GC already in flight may have snapshotted references before our retain.
                  // Re-persist through its barrier rather than returning metadata for deleted bytes.
                  return await persistAttachmentFromDataUrl({
                    dataUrl: `data:${cached.mimeType};base64,${base64}`,
                    mimeType: cached.mimeType,
                    id: cached.id,
                  });
                }
              } finally {
                release();
              }
            }
            const result = await client.readTimelineImage(agentId, image.id);
            return persistAttachmentFromBytes({
              bytes: result.bytes,
              mimeType: image.mimeType,
              id: `timeline-${image.id}`,
            });
          },
        });
      },
    })),
  );
  useEffect(() => {
    const releases = results.flatMap((result) =>
      result.data ? [retainAttachmentForGarbageCollection(result.data.id)] : [],
    );
    return () => releases.forEach((release) => release());
  }, [results]);
  return results.map((result, occurrence) => {
    const image = images[occurrence];
    const identity = image?.kind === "stored" ? image.id : "unavailable";
    return { result, key: `${identity}:${occurrence}`, unavailable: image?.kind === "unavailable" };
  });
}

import { useEffect } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { TimelineImage } from "@getpaseo/protocol/timeline-image";
import { useFetchQueries } from "@/data/query";
import { persistAttachmentFromBytes } from "./service";
import { retainAttachmentForGarbageCollection } from "./gc-retention";

export function useTimelineImages(input: {
  client?: DaemonClient | null;
  serverId?: string;
  agentId?: string;
  images: readonly TimelineImage[];
}) {
  const { client, serverId, agentId, images } = input;
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
        const result = await client.readTimelineImage(agentId, image.id);
        return persistAttachmentFromBytes({
          bytes: result.bytes,
          mimeType: image.mimeType,
          id: `timeline-${image.id}`,
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

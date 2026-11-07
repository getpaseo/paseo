import { useEffect, useMemo, useState } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { persistAttachmentFromBytes, resolveAttachmentPreviewUrl } from "@/attachments/service";
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
  const acquisition = useMemo(
    () =>
      createAssistantImageFileAcquisition({
        port: client
          ? {
              readFile: (cwd, path) => client.readFile(cwd, path),
              persist: persistAttachmentFromBytes,
            }
          : null,
        resolution: resolveAssistantImageSource({ source, workspaceRoot }),
        serverId,
        occurrenceKey,
        unavailableMessage: "Image unavailable",
      }),
    [client, occurrenceKey, serverId, source, workspaceRoot],
  );

  const cached = acquisition ? assistantImagePreviews.peek(acquisition.key) : undefined;
  const [value, setValue] = useState<AssistantImagePreview | null>(cached ?? null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!acquisition) {
      return;
    }
    let disposed = false;
    const held = assistantImagePreviews.acquireRetained(acquisition.key, async () => {
      const attachment = await acquisition.locate();
      const uri = await resolveAttachmentPreviewUrl(attachment);
      return { attachment, uri };
    });
    setValue(held.value ?? null);
    setFailed(false);
    void (async () => {
      try {
        const next = await held.promise;
        if (!disposed) {
          setValue(next);
        }
      } catch {
        if (!disposed) {
          setFailed(true);
        }
      }
    })();
    return () => {
      disposed = true;
      held.release();
    };
  }, [acquisition]);

  if (!acquisition) {
    return { status: "unavailable", uri: null };
  }
  if (failed) {
    return { status: "failed", uri: null };
  }
  return value ? { status: "loaded", uri: value.uri } : { status: "pending", uri: null };
}

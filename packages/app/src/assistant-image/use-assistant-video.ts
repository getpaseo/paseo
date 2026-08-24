import { useCallback, useEffect, useMemo, useReducer } from "react";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { isVideoMimeType, isVideoPath, resolveVideoMimeType } from "@/attachments/file-types";
import { localFileSourceToPath } from "@/attachments/utils";
import { persistAttachmentFromBytes } from "@/attachments/service";
import { resolveAssistantImageSource } from "@/utils/assistant-image-source";
import {
  createAssistantImageFileAcquisition,
  type AssistantImageFileAcquisitionPort,
} from "./file-acquisition";
import {
  createAssistantImageLifecycle,
  transitionAssistantImageLifecycle,
  type AssistantImageLifecycle,
  type AssistantImageLifecycleEvent,
} from "./lifecycle";
import { useAttachmentAcquisition, usePreviewUrl } from "./media-attachment";

// A timeline video takes the same route as a timeline image: the daemon hands the
// bytes over the existing file RPC and the client turns them into a preview URL.
// That keeps the feature working over the encrypted relay, where the daemon's HTTP
// port is not reachable, at the cost of holding the file in memory — hence the cap.
// Fifty megabytes covers the screen recordings agents actually produce; past that
// the daemon refuses on the file's stat, so an oversized video costs one round trip
// and no bytes.
export const MAX_INLINE_VIDEO_BYTES = 50 * 1024 * 1024;

export interface AssistantVideoRenderBinding {
  uri: string;
  mimeType: string | null;
  onLoadedMetadata: (dimensions: { width: number; height: number }) => void;
  onError: () => void;
}

export type AssistantVideoResult =
  | {
      status: "loading";
      binding: AssistantVideoRenderBinding | null;
      aspectRatio: number | null;
    }
  | {
      status: "loaded";
      binding: AssistantVideoRenderBinding;
      aspectRatio: number;
    }
  | { status: "failed"; message: string; path: string | null };

interface UseAssistantVideoInput {
  source: string;
  occurrenceKey: string;
  client?: DaemonClient | null;
  workspaceRoot?: string;
  serverId?: string;
}

function lifecycleReducer(
  state: AssistantImageLifecycle,
  event: AssistantImageLifecycleEvent,
): AssistantImageLifecycle {
  return transitionAssistantImageLifecycle(state, event);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function isAssistantVideoSource(source: string): boolean {
  const trimmed = source.trim();
  if (!trimmed) {
    return false;
  }
  return isVideoPath(localFileSourceToPath(trimmed));
}

export function useAssistantVideo({
  source,
  occurrenceKey,
  client,
  workspaceRoot,
  serverId,
}: UseAssistantVideoInput): AssistantVideoResult {
  const { t } = useTranslation();
  const resolution = useMemo(
    () => resolveAssistantImageSource({ source, workspaceRoot }),
    [source, workspaceRoot],
  );
  const mimeType = useMemo(
    () => resolveVideoMimeType({ path: localFileSourceToPath(source) }),
    [source],
  );
  // What the failure card names. A refusal that only says "too large" leaves the
  // reader guessing which of several videos in the turn it means.
  const sourcePath = resolution?.kind === "file_rpc" ? resolution.path : (resolution?.uri ?? null);
  const unavailableMessage = t("message.attachments.videoPreviewUnavailable");
  const fileAcquisition = useMemo(() => {
    const port: AssistantImageFileAcquisitionPort | null = client
      ? {
          readFile: async (cwd, path, maxBytes) =>
            await client.readFile(cwd, path, undefined, maxBytes),
          persist: persistAttachmentFromBytes,
        }
      : null;
    return createAssistantImageFileAcquisition({
      port,
      resolution,
      serverId,
      occurrenceKey,
      unavailableMessage,
      // The explorer reports video as a binary read, so the MIME type is what
      // separates a playable file from an arbitrary blob. A daemon too old to
      // know video extensions sends application/octet-stream and lands here.
      accept: (file) => isVideoMimeType(file.mime),
      maxBytes: MAX_INLINE_VIDEO_BYTES,
    });
  }, [client, occurrenceKey, resolution, serverId, unavailableMessage]);
  const fileAttachment = useAttachmentAcquisition(fileAcquisition);
  const preview = usePreviewUrl(
    fileAttachment.status === "loaded" ? fileAttachment.attachment : null,
  );
  const directUri = resolution?.kind === "direct" ? resolution.uri : null;
  const previewUri = preview.status === "loaded" ? preview.uri : null;
  const uri = directUri ?? previewUri;

  const [lifecycle, dispatch] = useReducer(
    lifecycleReducer,
    undefined,
    createAssistantImageLifecycle,
  );

  useEffect(() => {
    if (!uri) {
      dispatch({ type: "preview_released" });
      return;
    }
    dispatch({ type: "preview_created", uri, aspectRatio: null });
  }, [uri]);

  const handleError = useCallback(() => {
    if (uri) {
      dispatch({ type: "failed", uri, message: t("message.attachments.videoUnavailable") });
    }
  }, [t, uri]);

  const handleLoadedMetadata = useCallback(
    (dimensions: { width: number; height: number }) => {
      if (!uri) {
        return;
      }
      // Audio-only or still-decoding metadata reports zero, and an aspect ratio of
      // zero collapses the player to nothing. Treat it as a load failure instead.
      if (!(dimensions.width > 0 && dimensions.height > 0)) {
        dispatch({ type: "failed", uri, message: t("message.attachments.videoUnavailable") });
        return;
      }
      dispatch({ type: "media_loaded", uri, aspectRatio: dimensions.width / dimensions.height });
    },
    [t, uri],
  );

  if (!resolution) {
    return {
      status: "failed",
      message: t("message.attachments.videoPreviewLoadFailed"),
      path: localFileSourceToPath(source) || null,
    };
  }
  if (fileAttachment.status === "failed") {
    return {
      status: "failed",
      message: errorMessage(fileAttachment.error, t("message.attachments.videoPreviewLoadFailed")),
      path: sourcePath,
    };
  }
  if (!directUri && preview.status === "failed") {
    return {
      status: "failed",
      message: errorMessage(preview.error, t("message.attachments.videoPreviewLoadFailed")),
      path: sourcePath,
    };
  }
  if (lifecycle.status === "failed") {
    return { ...lifecycle, path: sourcePath };
  }

  const binding: AssistantVideoRenderBinding | null = lifecycle.uri
    ? {
        uri: lifecycle.uri,
        mimeType,
        onLoadedMetadata: handleLoadedMetadata,
        onError: handleError,
      }
    : null;

  if (lifecycle.status === "loaded" && binding) {
    return { status: "loaded", binding, aspectRatio: lifecycle.aspectRatio };
  }
  return { status: "loading", binding, aspectRatio: null };
}

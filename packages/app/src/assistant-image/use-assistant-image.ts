import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { Image } from "react-native";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AttachmentMetadata } from "@/attachments/types";
import { retainAttachmentForGarbageCollection } from "@/attachments/gc-retention";
import {
  persistAttachmentFromBytes,
  persistAttachmentFromDataUrl,
  releaseAttachmentPreviewUrl,
  resolveAttachmentPreviewUrl,
} from "@/attachments/service";
import {
  createPreviewAttachmentId,
  getFileNameFromPath,
  parseImageDataUrl,
} from "@/attachments/utils";
import {
  getAssistantImageMetadata,
  setAssistantImageMetadata,
} from "@/utils/assistant-image-metadata";
import { resolveAssistantImageSource } from "@/utils/assistant-image-source";
import type { AssistantImageSourceResolution } from "@/utils/assistant-image-source";
import {
  createAssistantImageAcquisitionCache,
  createAssistantImageFileAcquisitionKey,
  createAssistantImageFilePreviewAttachmentId,
} from "./acquisition-cache";
import {
  createAssistantImageLifecycle,
  transitionAssistantImageLifecycle,
  type AssistantImageLifecycle,
  type AssistantImageLifecycleEvent,
} from "./lifecycle";
import { runAssistantImageOperationWithRetry } from "./retry";

interface AssistantImageRenderBinding {
  uri: string;
  onLoad: () => void;
  onError: () => void;
}

export type AssistantImageResult =
  | {
      status: "loading";
      binding: AssistantImageRenderBinding | null;
      aspectRatio: number | null;
    }
  | {
      status: "loaded";
      binding: AssistantImageRenderBinding;
      aspectRatio: number;
    }
  | { status: "failed"; message: string };

interface UseAssistantImageInput {
  source: string;
  occurrenceKey: string;
  client?: DaemonClient | null;
  workspaceRoot?: string;
  serverId?: string;
}

type PreviewUrlState =
  | { status: "waiting" }
  | { status: "loading" }
  | { status: "loaded"; uri: string }
  | { status: "failed"; error: unknown };

type AttachmentAcquisitionState =
  | { status: "waiting" }
  | { status: "loading" }
  | { status: "loaded"; attachment: AttachmentMetadata }
  | { status: "failed"; error: unknown };

interface AttachmentAcquisition {
  key: string;
  locate: () => Promise<AttachmentMetadata>;
}

interface DataImage {
  mimeType: string;
  base64: string;
  cacheKey: string;
}

const attachmentAcquisitionCache = createAssistantImageAcquisitionCache<AttachmentMetadata>({
  capacity: 500,
  onRetain: (attachment) => retainAttachmentForGarbageCollection(attachment.id),
});

function acquireAttachment(acquisition: AttachmentAcquisition): Promise<AttachmentMetadata> {
  return attachmentAcquisitionCache.acquire(acquisition.key, acquisition.locate);
}

function useAttachmentAcquisition(
  acquisition: AttachmentAcquisition | null,
): AttachmentAcquisitionState {
  const [state, setState] = useState<AttachmentAcquisitionState>({ status: "waiting" });

  useEffect(() => {
    let disposed = false;
    if (!acquisition) {
      setState({ status: "waiting" });
      return;
    }

    setState({ status: "loading" });
    void (async () => {
      try {
        const attachment = await runAssistantImageOperationWithRetry({
          operation: async () => await acquireAttachment(acquisition),
          shouldStop: () => disposed,
        });
        if (!disposed) {
          setState({ status: "loaded", attachment });
        }
      } catch (error) {
        if (!disposed) {
          setState({ status: "failed", error });
        }
      }
    })();
    return () => {
      disposed = true;
    };
  }, [acquisition]);

  return state;
}

function createFileAcquisition(input: {
  client?: DaemonClient | null;
  resolution: AssistantImageSourceResolution | null;
  serverId?: string;
  occurrenceKey: string;
  unavailableMessage: string;
}): AttachmentAcquisition | null {
  if (input.resolution?.kind !== "file_rpc") {
    return null;
  }
  const { client, resolution } = input;
  return {
    key: createAssistantImageFileAcquisitionKey({
      serverId: input.serverId,
      occurrenceKey: input.occurrenceKey,
      cwd: resolution.cwd,
      path: resolution.path,
    }),
    locate: async () => {
      if (!client) {
        throw new Error(input.unavailableMessage);
      }
      const file = await client.readFile(resolution.cwd, resolution.path);
      if (file.kind !== "image") {
        throw new Error(input.unavailableMessage);
      }
      return await persistAttachmentFromBytes({
        id: createAssistantImageFilePreviewAttachmentId({
          serverId: input.serverId,
          occurrenceKey: input.occurrenceKey,
          mimeType: file.mime,
          path: file.path || resolution.path,
          size: file.size,
          modifiedAt: file.modifiedAt,
          contentLength: file.bytes.byteLength,
        }),
        bytes: file.bytes,
        mimeType: file.mime,
        fileName: getFileNameFromPath(file.path || resolution.path),
      });
    },
  };
}

function createDataImageAcquisition(input: {
  source: string;
  dataImage: DataImage | null;
}): AttachmentAcquisition | null {
  if (!input.dataImage) {
    return null;
  }
  const { dataImage, source } = input;
  return {
    key: dataImage.cacheKey,
    locate: async () =>
      await persistAttachmentFromDataUrl({
        id: createPreviewAttachmentId({
          mimeType: dataImage.mimeType,
          contentLength: dataImage.base64.length,
          contentKey: dataImage.cacheKey,
        }),
        dataUrl: source,
        mimeType: dataImage.mimeType,
      }),
  };
}

function usePreviewUrl(attachment: AttachmentMetadata | null | undefined): PreviewUrlState {
  const [state, setState] = useState<PreviewUrlState>({ status: "waiting" });
  const id = attachment?.id;
  const storageType = attachment?.storageType;
  const storageKey = attachment?.storageKey;
  const mimeType = attachment?.mimeType;

  useEffect(() => {
    let disposed = false;
    let previewUrl: string | null = null;
    const current = attachment;

    if (!current) {
      setState({ status: "waiting" });
      return;
    }

    setState({ status: "loading" });
    void (async () => {
      try {
        const uri = await runAssistantImageOperationWithRetry({
          operation: async () => await resolveAttachmentPreviewUrl(current),
          shouldStop: () => disposed,
        });
        if (disposed) {
          await releaseAttachmentPreviewUrl({ attachment: current, url: uri });
          return;
        }
        previewUrl = uri;
        setState({ status: "loaded", uri });
      } catch (error) {
        if (!disposed) {
          setState({ status: "failed", error });
        }
      }
    })();

    return () => {
      disposed = true;
      if (previewUrl) {
        void releaseAttachmentPreviewUrl({ attachment: current, url: previewUrl });
      }
    };
  }, [attachment, id, mimeType, storageKey, storageType]);

  return state;
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

function getAcquisitionFailure(input: {
  hasResolution: boolean;
  isFileSource: boolean;
  isDataImage: boolean;
  fileAttachment: AttachmentAcquisitionState;
  dataImageAttachment: AttachmentAcquisitionState;
  preview: PreviewUrlState;
  hasDirectUri: boolean;
  fallbackMessage: string;
}): AssistantImageResult | null {
  if (!input.hasResolution) {
    return { status: "failed", message: input.fallbackMessage };
  }
  if (input.isFileSource && input.fileAttachment.status === "failed") {
    return {
      status: "failed",
      message: errorMessage(input.fileAttachment.error, input.fallbackMessage),
    };
  }
  if (input.isDataImage && input.dataImageAttachment.status === "failed") {
    return {
      status: "failed",
      message: errorMessage(input.dataImageAttachment.error, input.fallbackMessage),
    };
  }
  if (!input.hasDirectUri && input.preview.status === "failed") {
    return {
      status: "failed",
      message: errorMessage(input.preview.error, input.fallbackMessage),
    };
  }
  return null;
}

export function useAssistantImage({
  source,
  occurrenceKey,
  client,
  workspaceRoot,
  serverId,
}: UseAssistantImageInput): AssistantImageResult {
  const { t } = useTranslation();
  const resolution = useMemo(
    () => resolveAssistantImageSource({ source, workspaceRoot }),
    [source, workspaceRoot],
  );
  const dataImage = useMemo(() => parseImageDataUrl(source), [source]);
  const fileAcquisition = useMemo(
    () =>
      createFileAcquisition({
        client,
        resolution,
        serverId,
        occurrenceKey,
        unavailableMessage: t("message.attachments.imagePreviewUnavailable"),
      }),
    [client, occurrenceKey, resolution, serverId, t],
  );
  const dataImageAcquisition = useMemo(
    () => createDataImageAcquisition({ source, dataImage }),
    [dataImage, source],
  );
  const fileAttachment = useAttachmentAcquisition(fileAcquisition);
  const dataImageAttachment = useAttachmentAcquisition(dataImageAcquisition);
  const filePreview = usePreviewUrl(
    fileAttachment.status === "loaded" ? fileAttachment.attachment : null,
  );
  const dataImagePreview = usePreviewUrl(
    dataImageAttachment.status === "loaded" ? dataImageAttachment.attachment : null,
  );
  const [lifecycle, dispatch] = useReducer(lifecycleReducer, undefined, () =>
    createAssistantImageLifecycle(),
  );

  const directUri = resolution?.kind === "direct" && !dataImage ? resolution.uri : null;
  const preview = dataImage ? dataImagePreview : filePreview;
  const previewUri = preview.status === "loaded" ? preview.uri : null;
  const uri = directUri ?? previewUri;
  const cachedMetadata = useMemo(
    () => getAssistantImageMetadata({ source, workspaceRoot, serverId }),
    [serverId, source, workspaceRoot],
  );

  useEffect(() => {
    if (!uri) {
      dispatch({ type: "preview_released" });
      return;
    }

    dispatch({
      type: "preview_created",
      uri,
      aspectRatio: cachedMetadata?.aspectRatio ?? null,
    });
  }, [cachedMetadata, uri]);

  const handleImageError = useCallback(() => {
    if (uri) {
      dispatch({
        type: "failed",
        uri,
        message: t("message.attachments.imageUnavailable"),
      });
    }
  }, [t, uri]);
  const handleImageLoad = useCallback(() => {
    if (!uri) {
      return;
    }
    Image.getSize(
      uri,
      (width, height) => {
        const metadata = setAssistantImageMetadata(
          { source, workspaceRoot, serverId },
          { width, height },
        );
        if (!metadata) {
          dispatch({
            type: "failed",
            uri,
            message: t("message.attachments.imageUnavailable"),
          });
          return;
        }
        dispatch({ type: "image_loaded", uri, aspectRatio: metadata.aspectRatio });
      },
      () => {
        dispatch({
          type: "failed",
          uri,
          message: t("message.attachments.imageUnavailable"),
        });
      },
    );
  }, [serverId, source, t, uri, workspaceRoot]);

  const acquisitionFailure = getAcquisitionFailure({
    hasResolution: resolution !== null,
    isFileSource: resolution?.kind === "file_rpc",
    isDataImage: dataImage !== null,
    fileAttachment,
    dataImageAttachment,
    preview,
    hasDirectUri: directUri !== null,
    fallbackMessage: t("message.attachments.imagePreviewLoadFailed"),
  });
  if (acquisitionFailure) {
    return acquisitionFailure;
  }
  const hasCurrentLifecycleUri = lifecycle.status !== "failed" && lifecycle.uri === uri;
  let binding: AssistantImageRenderBinding | null = null;
  if (hasCurrentLifecycleUri && lifecycle.uri) {
    binding = {
      uri: lifecycle.uri,
      onLoad: handleImageLoad,
      onError: handleImageError,
    };
  }
  if (lifecycle.status === "loaded" && lifecycle.uri === uri) {
    return {
      status: "loaded",
      binding: {
        uri: lifecycle.uri,
        onLoad: handleImageLoad,
        onError: handleImageError,
      },
      aspectRatio: lifecycle.aspectRatio,
    };
  }
  if (lifecycle.status === "failed") {
    return lifecycle;
  }
  return {
    status: "loading",
    binding,
    aspectRatio: hasCurrentLifecycleUri ? lifecycle.aspectRatio : null,
  };
}

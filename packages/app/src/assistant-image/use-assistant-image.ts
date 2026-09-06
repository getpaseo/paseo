import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { ImageLoadEvent } from "react-native";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { isWeb } from "@/constants/platform";
import { persistAttachmentFromBytes, persistAttachmentFromDataUrl } from "@/attachments/service";
import { createPreviewAttachmentId, parseImageDataUrl } from "@/attachments/utils";
import {
  getAssistantImageMetadata,
  setAssistantImageMetadata,
} from "@/utils/assistant-image-metadata";
import { resolveAssistantImageSource } from "@/utils/assistant-image-source";
import {
  useAttachmentAcquisition,
  usePreviewUrl,
  type AttachmentAcquisitionState,
  type PreviewUrlState,
} from "./media-attachment";
import {
  createAssistantImageFileAcquisition,
  type AssistantImageAcquisition,
  type AssistantImageFileAcquisitionPort,
} from "./file-acquisition";
import {
  createAssistantImageLifecycle,
  transitionAssistantImageLifecycle,
  type AssistantImageLifecycle,
  type AssistantImageLifecycleEvent,
} from "./lifecycle";
import {
  type AssistantImageRenderedDimensionsReader,
  resolveAssistantImageLoadDimensions,
} from "./load-dimensions";

interface AssistantImageRenderBinding {
  uri: string;
  onRef: (instance: unknown) => void;
  onLoad: (event: ImageLoadEvent) => void;
  onError: () => void;
}

const renderedDimensions: AssistantImageRenderedDimensionsReader = {
  read(renderedImage) {
    if (!isWeb || !(renderedImage instanceof HTMLElement)) {
      return null;
    }
    const image = renderedImage.querySelector("img");
    return image && image.naturalWidth > 0 && image.naturalHeight > 0
      ? { width: image.naturalWidth, height: image.naturalHeight }
      : null;
  },
};

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

interface DataImage {
  mimeType: string;
  base64: string;
  cacheKey: string;
}

const LOADED_IMAGE_CACHE_CAPACITY = 500;
const loadedImageCache = new Map<string, number>();

function getLoadedImageAspectRatio(uri: string): number | null {
  const aspectRatio = loadedImageCache.get(uri);
  if (aspectRatio === undefined) {
    return null;
  }
  loadedImageCache.delete(uri);
  loadedImageCache.set(uri, aspectRatio);
  return aspectRatio;
}

function rememberLoadedImage(uri: string, aspectRatio: number): void {
  loadedImageCache.delete(uri);
  loadedImageCache.set(uri, aspectRatio);
  if (loadedImageCache.size <= LOADED_IMAGE_CACHE_CAPACITY) {
    return;
  }
  const leastRecentlyUsedUri = loadedImageCache.keys().next().value;
  if (leastRecentlyUsedUri !== undefined) {
    loadedImageCache.delete(leastRecentlyUsedUri);
  }
}

function createDataImageAcquisition(input: {
  source: string;
  dataImage: DataImage | null;
}): AssistantImageAcquisition | null {
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
  const fileAcquisition = useMemo(() => {
    const port: AssistantImageFileAcquisitionPort | null = client
      ? {
          readFile: async (cwd, path) => await client.readFile(cwd, path),
          persist: persistAttachmentFromBytes,
        }
      : null;
    return createAssistantImageFileAcquisition({
      port,
      resolution,
      serverId,
      occurrenceKey,
      unavailableMessage: t("message.attachments.imagePreviewUnavailable"),
    });
  }, [client, occurrenceKey, resolution, serverId, t]);
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
  const directUri = resolution?.kind === "direct" && !dataImage ? resolution.uri : null;
  const preview = dataImage ? dataImagePreview : filePreview;
  const previewUri = preview.status === "loaded" ? preview.uri : null;
  const uri = directUri ?? previewUri;
  const cachedMetadata = useMemo(
    () => getAssistantImageMetadata({ source, workspaceRoot, serverId }),
    [serverId, source, workspaceRoot],
  );
  const [lifecycle, dispatchLifecycle] = useReducer(
    lifecycleReducer,
    uri,
    (initialUri): AssistantImageLifecycle => {
      if (initialUri) {
        const aspectRatio = getLoadedImageAspectRatio(initialUri);
        if (aspectRatio !== null) {
          return { status: "loaded", uri: initialUri, aspectRatio };
        }
      }
      return createAssistantImageLifecycle();
    },
  );
  const dispatch = useCallback((event: AssistantImageLifecycleEvent) => {
    if (event.type === "media_loaded") {
      rememberLoadedImage(event.uri, event.aspectRatio);
    } else if (event.type === "failed" && event.uri) {
      loadedImageCache.delete(event.uri);
    }
    dispatchLifecycle(event);
  }, []);
  const renderedImageRef = useRef<unknown>(null);
  const handleImageRef = useCallback((instance: unknown) => {
    renderedImageRef.current = instance;
  }, []);

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
  }, [cachedMetadata, dispatch, uri]);

  const handleImageError = useCallback(() => {
    if (uri) {
      dispatch({
        type: "failed",
        uri,
        message: t("message.attachments.imageUnavailable"),
      });
    }
  }, [dispatch, t, uri]);
  const handleImageLoad = useCallback(
    (event: ImageLoadEvent) => {
      if (!uri) {
        return;
      }
      const nativeEvent = event.nativeEvent as ImageLoadEvent["nativeEvent"] & {
        target?: { naturalWidth?: unknown; naturalHeight?: unknown };
      };
      const dimensions = resolveAssistantImageLoadDimensions({
        source: nativeEvent.source,
        target: nativeEvent.target,
        renderedImage: renderedImageRef.current,
        renderedDimensions,
      });
      const metadata = dimensions
        ? setAssistantImageMetadata({ source, workspaceRoot, serverId }, dimensions)
        : null;
      const aspectRatio = metadata?.aspectRatio ?? cachedMetadata?.aspectRatio ?? null;
      if (!aspectRatio) {
        dispatch({
          type: "failed",
          uri,
          message: t("message.attachments.imageUnavailable"),
        });
        return;
      }
      dispatch({ type: "media_loaded", uri, aspectRatio });
    },
    [cachedMetadata, dispatch, serverId, source, t, uri, workspaceRoot],
  );

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
      onRef: handleImageRef,
      onLoad: handleImageLoad,
      onError: handleImageError,
    };
  }
  if (lifecycle.status === "loaded" && lifecycle.uri === uri) {
    return {
      status: "loaded",
      binding: {
        uri: lifecycle.uri,
        onRef: handleImageRef,
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

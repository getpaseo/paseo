import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ImageLoadEvent } from "react-native";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AttachmentMetadata } from "@/attachments/types";
import { isWeb } from "@/constants/platform";
import { useStableEvent } from "@/hooks/use-stable-event";
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
  onRef: (instance: unknown) => void;
  onLoad: (event: ImageLoadEvent) => void;
  onError: () => void;
}

function getImageLoadDimensions(
  event: ImageLoadEvent,
  renderedImage: unknown,
): { width: number; height: number } | null {
  const nativeEvent = event.nativeEvent as ImageLoadEvent["nativeEvent"] & {
    target?: { naturalWidth?: unknown; naturalHeight?: unknown };
  };
  const source = nativeEvent.source;
  if (source && source.width > 0 && source.height > 0) {
    return source;
  }
  const { naturalWidth, naturalHeight } = nativeEvent.target ?? {};
  if (
    typeof naturalWidth === "number" &&
    typeof naturalHeight === "number" &&
    naturalWidth > 0 &&
    naturalHeight > 0
  ) {
    return { width: naturalWidth, height: naturalHeight };
  }

  if (isWeb && renderedImage instanceof HTMLElement) {
    const image = renderedImage.querySelector("img");
    if (image && image.naturalWidth > 0 && image.naturalHeight > 0) {
      return { width: image.naturalWidth, height: image.naturalHeight };
    }
  }
  return null;
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

function acquireAttachment(acquisition: AttachmentAcquisition): Promise<AttachmentMetadata> {
  return attachmentAcquisitionCache.acquire(acquisition.key, acquisition.locate);
}

function useAttachmentAcquisition(
  acquisition: AttachmentAcquisition | null,
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
    if (!acquisition || !acquisitionKey) {
      setEntry({ key: null, state: { status: "waiting" } });
      return;
    }

    const cached = attachmentAcquisitionCache.peek(acquisitionKey);
    if (cached) {
      setEntry({ key: acquisitionKey, state: { status: "loaded", attachment: cached } });
      return;
    }

    setEntry({ key: acquisitionKey, state: { status: "loading" } });
    void (async () => {
      try {
        const attachment = await runAssistantImageOperationWithRetry({
          operation: async () => await acquireAttachment(acquisition),
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
  const id = attachment?.id;
  const storageType = attachment?.storageType;
  const storageKey = attachment?.storageKey;
  const mimeType = attachment?.mimeType;
  const previewKey =
    id && storageType && storageKey && mimeType
      ? `${id}:${storageType}:${storageKey}:${mimeType}`
      : null;
  const [entry, setEntry] = useState<{ key: string | null; state: PreviewUrlState }>(() => {
    const cached = previewKey ? previewUrlCache.peek(previewKey) : undefined;
    return {
      key: previewKey,
      state: cached ? { status: "loaded", uri: cached.uri } : { status: "waiting" },
    };
  });
  const getCurrentAttachment = useStableEvent(() => attachment ?? null);

  useEffect(() => {
    let disposed = false;
    const current = getCurrentAttachment();

    if (!current || !previewKey) {
      setEntry({ key: null, state: { status: "waiting" } });
      return;
    }

    const cached = previewUrlCache.peek(previewKey);
    if (cached) {
      setEntry({ key: previewKey, state: { status: "loaded", uri: cached.uri } });
      return;
    }

    setEntry({ key: previewKey, state: { status: "loading" } });
    void (async () => {
      try {
        const preview = await runAssistantImageOperationWithRetry({
          operation: async () =>
            await previewUrlCache.acquire(previewKey, async () => ({
              attachment: current,
              uri: await resolveAttachmentPreviewUrl(current),
            })),
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
    };
  }, [getCurrentAttachment, previewKey]);

  if (!previewKey) {
    return { status: "waiting" };
  }
  const cached = previewUrlCache.peek(previewKey);
  if (cached) {
    return { status: "loaded", uri: cached.uri };
  }
  return entry.key === previewKey ? entry.state : { status: "waiting" };
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
    if (event.type === "image_loaded") {
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
      const dimensions = getImageLoadDimensions(event, renderedImageRef.current);
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
      dispatch({ type: "image_loaded", uri, aspectRatio });
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

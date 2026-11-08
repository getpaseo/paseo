import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { Image, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { createAssistantImageAcquisitionCache } from "@/assistant-image/acquisition-cache";
import { createAssistantImageFileAcquisition } from "@/assistant-image/file-acquisition";
import { retainAttachmentForGarbageCollection } from "@/attachments/gc-retention";
import {
  persistAttachmentFromBytes,
  releaseAttachmentPreviewUrl,
  resolveAttachmentPreviewUrl,
} from "@/attachments/service";
import type { AttachmentMetadata } from "@/attachments/types";
import { useFetchQuery } from "@/data/query";
import { useSessionStore } from "@/stores/session-store";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import type { Theme } from "@/styles/theme";
import { resolveAssistantImageSource } from "@/utils/assistant-image-source";
import { AttachmentLightbox, type ImageLightboxSource } from "./attachment-lightbox";
import { PressHighlight } from "./ui/press-highlight";
import { LoadingSpinner } from "./ui/loading-spinner";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const spinnerColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface ReadImagePreview {
  attachment: AttachmentMetadata;
  uri: string;
}

// Reopening a read image should not read its bytes again. Like Markdown images, a resolved preview
// is kept while a component holds it and the attachment stays out of garbage collection until the
// entry is evicted.
const previews = createAssistantImageAcquisitionCache<ReadImagePreview>({
  capacity: 50,
  onRetain: ({ attachment, uri }) => {
    const releaseRetention = retainAttachmentForGarbageCollection(attachment.id);
    return () => {
      releaseRetention();
      void releaseAttachmentPreviewUrl({ attachment, url: uri });
    };
  },
});

interface ToolCallReadImageProps {
  serverId?: string;
  cwd?: string;
  filePath: string;
  maxHeight?: number;
}

/**
 * The image an agent's read tool opened, shown where the text of a read would be. The bytes come
 * from the same file read RPC that Markdown images use, so no image data travels in the timeline.
 */
export function ToolCallReadImage({
  serverId,
  cwd,
  filePath,
  maxHeight = 240,
}: ToolCallReadImageProps) {
  const { t } = useTranslation();
  const client = useSessionStore((state) =>
    serverId ? (state.sessions[serverId]?.client ?? null) : null,
  );
  const resolution = useMemo(
    () => resolveAssistantImageSource({ source: filePath, workspaceRoot: cwd }),
    [cwd, filePath],
  );
  const acquisition = useMemo(
    () =>
      createAssistantImageFileAcquisition({
        port: client
          ? {
              readFile: (readCwd, path) => client.readFile(readCwd, path),
              persist: persistAttachmentFromBytes,
            }
          : null,
        resolution,
        serverId,
        occurrenceKey: `tool-call:${serverId ?? "unknown"}:${cwd ?? ""}:${filePath}`,
        unavailableMessage: t("message.attachments.imageUnavailable"),
      }),
    [client, cwd, filePath, resolution, serverId, t],
  );
  const preview = useFetchQuery<ReadImagePreview>({
    queryKey: [
      "toolCallReadImage",
      acquisition?.key ?? `unavailable:${serverId}:${cwd}:${filePath}`,
    ],
    enabled: acquisition !== null,
    dataShape: "value",
    immutableWhen: () => true,
    gcTime: 0,
    queryFn: async () => {
      if (!acquisition) throw new Error(t("message.attachments.imageUnavailable"));
      return await previews.acquire(acquisition.key, async () => {
        const attachment = await acquisition.locate();
        const uri = await resolveAttachmentPreviewUrl(attachment);
        return { attachment, uri };
      });
    },
  });

  useEffect(() => {
    const value = preview.data;
    if (!acquisition || !value) return;
    return previews.acquireRetained(acquisition.key, async () => value).release;
  }, [acquisition, preview.data]);

  const uri = preview.data?.uri ?? null;
  const [decodeFailed, setDecodeFailed] = useState(false);
  useEffect(() => {
    setDecodeFailed(false);
  }, [uri]);
  const [open, setOpen] = useState(false);

  const openImage = useCallback(() => setOpen(true), []);
  const handleDecodeError = useCallback(() => setDecodeFailed(true), []);
  const closeImage = useCallback(() => setOpen(false), []);
  const imageSource = useMemo(() => ({ uri: uri ?? "" }), [uri]);
  const lightboxSource = useMemo<ImageLightboxSource | null>(
    () => (uri ? { type: "uri", uri, title: filePath } : null),
    [filePath, uri],
  );
  const frameStyle = useMemo(
    () => [styles.frame, inlineUnistylesStyle({ height: maxHeight })],
    [maxHeight],
  );
  const loadingFrameStyle = useMemo(
    () => [styles.frame, inlineUnistylesStyle({ height: Math.min(maxHeight, 120) })],
    [maxHeight],
  );

  let body: ReactNode;
  if (!acquisition || preview.isError || decodeFailed) {
    body = <Text style={styles.unavailable}>{t("message.attachments.imageUnavailable")}</Text>;
  } else if (!uri) {
    body = (
      <View style={loadingFrameStyle}>
        <ThemedLoadingSpinner size="small" uniProps={spinnerColorMapping} />
      </View>
    );
  } else {
    body = (
      <PressHighlight
        accessibilityLabel={t("toolCallDetails.openImage")}
        accessibilityRole="button"
        highlightStyle={styles.imageHighlight}
        onPress={openImage}
        style={frameStyle}
        testID="tool-call-read-image"
      >
        <Image
          onError={handleDecodeError}
          resizeMode="contain"
          source={imageSource}
          style={styles.image}
          testID="tool-call-read-image-content"
        />
      </PressHighlight>
    );
  }

  return (
    <>
      <View style={styles.container}>
        <Text
          ellipsizeMode="middle"
          numberOfLines={1}
          style={styles.path}
          testID="tool-call-read-image-path"
        >
          {filePath}
        </Text>
        {body}
      </View>
      {open && lightboxSource ? (
        <AttachmentLightbox source={lightboxSource} onClose={closeImage} />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { gap: theme.spacing[1], width: "100%" },
  path: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  },
  frame: {
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
    overflow: "hidden",
  },
  image: { width: "100%", height: "100%" },
  imageHighlight: { backgroundColor: theme.colors.surface2 },
  unavailable: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
}));

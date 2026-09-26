import { useCallback, useMemo, useState } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useTranslation } from "react-i18next";
import { Image, Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useAssistantImage } from "@/assistant-image/use-assistant-image";
import { AttachmentLightbox, type ImageLightboxSource } from "@/components/attachment-lightbox";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type { Theme } from "@/styles/theme";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

const PREVIEW_IMAGE_MIN_HEIGHT = 160;

export function FileMarkdownPreviewImage({
  source,
  occurrenceKey,
  alt,
  client,
  workspaceRoot,
  serverId,
}: {
  source: string;
  occurrenceKey: string;
  alt?: string;
  client?: DaemonClient | null;
  workspaceRoot?: string;
  serverId?: string;
}) {
  const { t } = useTranslation();
  const [viewerOpen, setViewerOpen] = useState(false);
  const openViewer = useCallback(() => setViewerOpen(true), []);
  const closeViewer = useCallback(() => setViewerOpen(false), []);
  const image = useAssistantImage({
    source,
    occurrenceKey,
    client,
    workspaceRoot,
    serverId,
  });
  const binding = image.status === "failed" ? null : image.binding;
  const aspectRatio = image.status === "failed" ? null : image.aspectRatio;
  const imageUri = binding?.uri ?? "";
  const imageSource = useMemo(() => ({ uri: imageUri }), [imageUri]);
  const imageSizeStyle = useMemo<ViewStyle>(() => {
    if (aspectRatio) {
      return { aspectRatio };
    }
    return { height: PREVIEW_IMAGE_MIN_HEIGHT };
  }, [aspectRatio]);
  const surfaceStyle = useMemo<StyleProp<ViewStyle>>(
    () => [styles.surface, imageSizeStyle],
    [imageSizeStyle],
  );
  const lightboxSource = useMemo<ImageLightboxSource | null>(() => {
    if (!viewerOpen || !imageUri) return null;
    return {
      type: "uri",
      uri: imageUri,
      contentSize: aspectRatio ? { width: aspectRatio, height: 1 } : undefined,
    };
  }, [aspectRatio, imageUri, viewerOpen]);

  if (image.status === "failed") {
    return (
      <View style={[styles.frame, styles.state]} testID="markdown-preview-image-failed">
        <Text style={styles.errorText}>{image.message}</Text>
      </View>
    );
  }

  if (!binding) {
    return (
      <View style={[styles.frame, styles.state]} testID="markdown-preview-image-loading">
        <ThemedLoadingSpinner size="small" uniProps={foregroundMutedColorMapping} />
      </View>
    );
  }

  return (
    <View style={styles.frame} testID="markdown-preview-image">
      <Pressable
        accessibilityLabel={t("composer.attachments.openImage")}
        accessibilityRole="button"
        disabled={image.status !== "loaded"}
        onPress={openViewer}
        style={surfaceStyle}
      >
        <View style={styles.image} accessibilityRole="image" accessibilityLabel={alt}>
          <Image
            ref={binding.onRef}
            source={imageSource}
            style={styles.image}
            resizeMode="contain"
            onLoad={binding.onLoad}
            onError={binding.onError}
          />
          {image.status === "loading" ? (
            <View pointerEvents="none" style={styles.loadingOverlay}>
              <ThemedLoadingSpinner size="small" uniProps={foregroundMutedColorMapping} />
            </View>
          ) : null}
        </View>
      </Pressable>
      <AttachmentLightbox source={lightboxSource} onClose={closeViewer} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  frame: {
    width: "100%",
    marginBottom: theme.spacing[4],
  },
  surface: {
    width: "100%",
    overflow: "hidden",
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
  image: {
    width: "100%",
    height: "100%",
  },
  state: {
    minHeight: PREVIEW_IMAGE_MIN_HEIGHT,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[6],
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
  },
  loadingOverlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  errorText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
}));

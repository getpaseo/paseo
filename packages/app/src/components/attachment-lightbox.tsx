import { useCallback, useEffect, useMemo, useState } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { AttachmentMetadata } from "@/attachments/types";
import { useAttachmentPreviewUrl } from "@/attachments/use-attachment-preview-url";
import { isWeb } from "@/constants/platform";
import { WindowChromeRootRegion, WindowChromeSafeArea } from "@/utils/desktop-window";
import { ZoomableImage } from "@/components/zoomable-viewport/image";
import type { ViewportSize } from "@/components/zoomable-viewport/geometry";

export type ImageLightboxSource =
  | { type: "attachment"; metadata: AttachmentMetadata }
  | { type: "uri"; uri: string; contentSize?: ViewportSize };

interface AttachmentLightboxProps {
  source: ImageLightboxSource | null;
  onClose: () => void;
}

export function AttachmentLightbox({ source, onClose }: AttachmentLightboxProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const metadata = source?.type === "attachment" ? source.metadata : null;
  const attachmentUrl = useAttachmentPreviewUrl(metadata);
  const url = source?.type === "uri" ? source.uri : attachmentUrl;
  const contentSize = source?.type === "uri" ? source.contentSize : undefined;
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    setErrored(false);
  }, [metadata?.id, url]);

  useEffect(() => {
    if (!isWeb || !source) return;
    function handleKeydown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", handleKeydown);
    return () => {
      window.removeEventListener("keydown", handleKeydown);
    };
  }, [onClose, source]);

  const closeButtonRowStyle = useMemo(
    () => [
      styles.closeButtonRow,
      {
        top: insets.top + theme.spacing[3],
      },
    ],
    [insets.top, theme.spacing],
  );
  const closeButtonStyle = useMemo(
    () => [styles.closeButton, { marginRight: insets.right + theme.spacing[3] }],
    [insets.right, theme.spacing],
  );

  const handleImageError = useCallback(() => setErrored(true), []);

  if (!source) {
    return null;
  }

  const hasError = errored || !url;

  return (
    <Modal transparent animationType="fade" statusBarTranslucent visible onRequestClose={onClose}>
      <WindowChromeRootRegion corners="both">
        <View style={styles.root}>
          <Pressable
            testID="attachment-lightbox-backdrop"
            accessibilityRole="button"
            accessibilityLabel={t("message.attachments.dismissImage")}
            onPress={onClose}
            style={styles.backdrop}
          />
          <View pointerEvents="box-none" style={styles.contentLayer}>
            <View pointerEvents="box-none" style={styles.imageArea}>
              {hasError ? (
                <Text style={styles.errorText}>{t("message.attachments.imageLoadFailed")}</Text>
              ) : (
                <View style={styles.imageViewport}>
                  <ZoomableImage
                    accessibilityLabel={t("composer.attachments.openImage")}
                    contentSize={contentSize}
                    onError={handleImageError}
                    testID="attachment-lightbox"
                    uri={url}
                  />
                </View>
              )}
            </View>
            <WindowChromeSafeArea placement="inline" style={closeButtonRowStyle}>
              <Pressable
                testID="attachment-lightbox-close"
                accessibilityRole="button"
                accessibilityLabel={t("message.attachments.closeImage")}
                hitSlop={8}
                onPress={onClose}
                style={closeButtonStyle}
              >
                <X size={16} color={theme.colors.foregroundMuted} />
              </Pressable>
            </WindowChromeSafeArea>
          </View>
        </View>
      </WindowChromeRootRegion>
    </Modal>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
  },
  backdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.9)",
  },
  contentLayer: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  closeButtonRow: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "flex-end",
  },
  imageArea: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
  },
  imageViewport: {
    flex: 1,
    width: "100%",
    alignSelf: "center",
    maxWidth: 960,
    maxHeight: 640,
  },
  errorText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  closeButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1,
  },
}));

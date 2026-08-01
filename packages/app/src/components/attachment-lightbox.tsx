import { useCallback, useEffect, useMemo, useState } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { AttachmentMetadata } from "@/attachments/types";
import { useAttachmentPreviewUrl } from "@/attachments/use-attachment-preview-url";
import { isNative, isWeb } from "@/constants/platform";
import { WindowChromeRootRegion, WindowChromeSafeArea } from "@/utils/desktop-window";
import { useSaveImage } from "@/images/use-save-image";
import { ZoomableImage } from "@/components/zoomable-image";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type {
  ImageSaveStatus,
  UseSaveImageInput,
  UseSaveImageResult,
} from "@/images/use-save-image";

function getSaveFeedbackText(status: ImageSaveStatus, t: TFunction): string | null {
  switch (status) {
    case "saving":
      return t("message.attachments.imageSaving");
    case "saved":
      return t("message.attachments.imageSaved");
    case "permissionDenied":
      return t("message.attachments.imageSavePermissionDenied");
    case "failed":
      return t("message.attachments.imageSaveFailed");
    case "idle":
      return null;
  }
}

interface AttachmentLightboxProps {
  metadata?: AttachmentMetadata | null;
  uri?: string | null;
  mimeType?: string;
  onClose: () => void;
  useImageSave?: (input: UseSaveImageInput) => UseSaveImageResult;
}

export function AttachmentLightbox({
  metadata = null,
  uri = null,
  mimeType,
  onClose,
  useImageSave = useSaveImage,
}: AttachmentLightboxProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const previewUrl = useAttachmentPreviewUrl(metadata);
  const url = uri ?? previewUrl;
  const [errored, setErrored] = useState(false);
  const imageSave = useImageSave({ uri: url, mimeType: mimeType ?? metadata?.mimeType });
  const saveFeedbackText = getSaveFeedbackText(imageSave.status, t);

  useEffect(() => {
    setErrored(false);
  }, [metadata?.id, uri]);

  useEffect(() => {
    if (!isWeb || (!metadata && !uri)) return;
    function handleKeydown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", handleKeydown);
    return () => {
      window.removeEventListener("keydown", handleKeydown);
    };
  }, [metadata, onClose, uri]);

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
  const saveFeedbackStyle = useMemo(
    () => [styles.saveFeedback, { bottom: insets.bottom + theme.spacing[3] }],
    [insets.bottom, theme.spacing],
  );

  const handleImageError = useCallback(() => setErrored(true), []);
  if (!metadata && !uri) {
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
          <View style={styles.contentLayer}>
            <View style={styles.imageArea}>
              {hasError ? (
                <Text style={styles.errorText}>{t("message.attachments.imageLoadFailed")}</Text>
              ) : (
                <View style={styles.imageViewport}>
                  <ZoomableImage
                    testID="attachment-lightbox-image"
                    uri={url}
                    accessibilityLabel={t("message.attachments.imagePreview")}
                    onError={handleImageError}
                    onLongPress={isNative ? imageSave.save : undefined}
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
            {saveFeedbackText ? (
              <View
                accessibilityLiveRegion="polite"
                accessibilityRole="text"
                style={saveFeedbackStyle}
              >
                {imageSave.status === "saving" ? (
                  <LoadingSpinner color={theme.colors.foregroundMuted} />
                ) : null}
                <Text style={styles.saveFeedbackText}>{saveFeedbackText}</Text>
              </View>
            ) : null}
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
    pointerEvents: "box-none",
  },
  closeButtonRow: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "flex-end",
    pointerEvents: "box-none",
  },
  imageArea: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
    pointerEvents: "box-none",
  },
  imageViewport: {
    flex: 1,
    width: "100%",
    alignSelf: "center",
    maxWidth: 960,
  },
  errorText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
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
  saveFeedback: {
    position: "absolute",
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  saveFeedbackText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
}));

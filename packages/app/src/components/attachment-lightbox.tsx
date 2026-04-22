import { useEffect, useState } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Image as ExpoImage } from "expo-image";
import { X } from "lucide-react-native";
import type { AttachmentMetadata } from "@/attachments/types";
import { useAttachmentPreviewUrl } from "@/attachments/use-attachment-preview-url";
import { isWeb } from "@/constants/platform";

interface AttachmentLightboxProps {
  metadata: AttachmentMetadata | null;
  onClose: () => void;
}

export function AttachmentLightbox({ metadata, onClose }: AttachmentLightboxProps) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const url = useAttachmentPreviewUrl(metadata);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    setErrored(false);
  }, [metadata?.id]);

  useEffect(() => {
    if (!isWeb || !metadata) return;
    function handleKeydown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", handleKeydown);
    return () => {
      window.removeEventListener("keydown", handleKeydown);
    };
  }, [metadata, onClose]);

  if (!metadata) {
    return null;
  }

  const hasError = errored || !url;

  return (
    <Modal transparent animationType="fade" statusBarTranslucent visible onRequestClose={onClose}>
      <View style={styles.root}>
        <Pressable
          testID="attachment-lightbox-backdrop"
          accessibilityRole="button"
          accessibilityLabel="Dismiss image"
          onPress={onClose}
          style={styles.backdrop}
        />
        <View style={styles.contentLayer}>
          <View style={styles.imageArea}>
            {hasError ? (
              <Text style={styles.errorText}>Couldn't load image</Text>
            ) : (
              <Pressable onPress={() => {}} style={styles.imagePressable}>
                <ExpoImage
                  testID="attachment-lightbox-image"
                  source={{ uri: url }}
                  contentFit="contain"
                  onError={() => setErrored(true)}
                  style={imageFillStyle}
                />
              </Pressable>
            )}
          </View>
          <Pressable
            testID="attachment-lightbox-close"
            accessibilityRole="button"
            accessibilityLabel="Close image"
            hitSlop={8}
            onPress={onClose}
            style={[
              styles.closeButton,
              {
                top: insets.top + theme.spacing[3],
                right: insets.right + theme.spacing[3],
              },
            ]}
          >
            <X size={16} color={theme.colors.foregroundMuted} />
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const imageFillStyle = {
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
} as const;

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
  imageArea: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
    pointerEvents: "box-none",
  },
  imagePressable: {
    flex: 1,
    width: "100%",
    alignSelf: "center",
    maxWidth: 960,
    maxHeight: 640,
  },
  errorText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  closeButton: {
    position: "absolute",
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

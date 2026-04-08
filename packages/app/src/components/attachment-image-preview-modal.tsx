import { useEffect } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { Modal, Platform, Pressable, View, Image, Text, useWindowDimensions } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";
import { X } from "lucide-react-native";
import { getOverlayRoot, OVERLAY_Z } from "@/lib/overlay-root";

interface AttachmentImagePreviewModalProps {
  visible: boolean;
  imageUri: string | null;
  fileName?: string | null;
  onClose: () => void;
}

function PreviewFrame({
  imageUri,
  fileName,
  onClose,
}: Omit<AttachmentImagePreviewModalProps, "visible">) {
  const { width: winW, height: winH } = useWindowDimensions();
  const cardHeight = Math.round(Math.min(winH * 0.75, 820));
  const cardMaxWidth = Math.round(Math.min(winW * 0.88, 1000));

  if (!imageUri) {
    return null;
  }

  const content = (
    <View style={[styles.fullScreen, { width: winW, height: winH }]}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View pointerEvents="box-none" style={styles.dialogContainer}>
        <View style={[styles.imageCard, { height: cardHeight, maxWidth: cardMaxWidth }]}>
          <Image source={{ uri: imageUri }} style={styles.image} resizeMode="contain" />
          <Pressable
            accessibilityLabel="Close image preview"
            onPress={onClose}
            style={styles.closeButton}
          >
            <X size={18} color="white" />
          </Pressable>
        </View>
        {fileName ? (
          <View style={[styles.captionRow, { maxWidth: cardMaxWidth }]}>
            <Text numberOfLines={1} style={styles.fileName}>
              {fileName}
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );

  // On native, wrap with SafeAreaView to respect notch/status bar
  if (Platform.OS !== "web") {
    return (
      <SafeAreaView edges={["top", "bottom"]} style={styles.safeArea}>
        {content}
      </SafeAreaView>
    );
  }

  return content;
}

export function AttachmentImagePreviewModal({
  visible,
  imageUri,
  fileName,
  onClose,
}: AttachmentImagePreviewModalProps) {
  useEffect(() => {
    if (!visible || Platform.OS !== "web" || typeof document === "undefined") {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, visible]);

  if (!visible || !imageUri) {
    return null;
  }

  const content: ReactNode = <PreviewFrame imageUri={imageUri} fileName={fileName} onClose={onClose} />;

  if (Platform.OS === "web" && typeof document !== "undefined") {
    return createPortal(<View style={styles.portalRoot}>{content}</View>, getOverlayRoot());
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      hardwareAccelerated
      statusBarTranslucent={Platform.OS === "android"}
      onRequestClose={onClose}
    >
      {content}
    </Modal>
  );
}

const styles = StyleSheet.create((theme) => ({
  portalRoot: {
    ...StyleSheet.absoluteFillObject,
    zIndex: OVERLAY_Z.modal,
    pointerEvents: "auto" as const,
  },
  safeArea: {
    flex: 1,
  },
  fullScreen: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0, 0, 0, 0.88)",
  },
  dialogContainer: {
    width: "100%",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[6],
    paddingVertical: theme.spacing[6],
    gap: theme.spacing[3],
    pointerEvents: "box-none" as const,
  },
  imageCard: {
    width: "100%",
    borderRadius: theme.borderRadius.xl,
    overflow: "hidden",
    backgroundColor: "rgba(15,15,15,0.5)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    position: "relative",
  },
  closeButton: {
    position: "absolute",
    top: 12,
    right: 12,
    width: 36,
    height: 36,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: "rgba(180, 220, 255, 0.65)",
    backgroundColor: "rgba(8, 12, 18, 0.85)",
    alignItems: "center",
    justifyContent: "center",
  },
  image: {
    width: "100%",
    height: "100%",
  },
  captionRow: {
    width: "100%",
  },
  fileName: {
    color: "rgba(230, 239, 250, 0.9)",
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
})) as Record<string, any>;

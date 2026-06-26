import { useCallback, useEffect, useMemo } from "react";
import { Modal, Pressable, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { isWeb } from "@/constants/platform";
import { MermaidZoomableView } from "@/components/markdown/mermaid/mermaid-zoomable-view";
import type { Theme } from "@/styles/theme";

interface MermaidLightboxProps {
  svg: string | null;
  onClose: () => void;
}

const LIGHTBOX_EDGE_GAP = 12;

const ThemedX = withUnistyles(X);

const mutedIconColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function MermaidLightbox({ svg, onClose }: MermaidLightboxProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (!isWeb || !svg) {
      return;
    }
    function handleKeydown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", handleKeydown);
    return () => {
      window.removeEventListener("keydown", handleKeydown);
    };
  }, [onClose, svg]);

  const closeButtonStyle = useMemo(
    () => [
      styles.closeButton,
      {
        top: insets.top + LIGHTBOX_EDGE_GAP,
        right: insets.right + LIGHTBOX_EDGE_GAP,
      },
    ],
    [insets.right, insets.top],
  );

  const handleBackdropPress = useCallback(() => onClose(), [onClose]);

  if (!svg) {
    return null;
  }

  return (
    <Modal transparent animationType="fade" statusBarTranslucent visible onRequestClose={onClose}>
      <View style={styles.root}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("markdown.mermaid.closeFullscreen")}
          onPress={handleBackdropPress}
          style={styles.backdrop}
        />
        <View style={styles.contentLayer}>
          <View style={styles.diagramArea}>
            <MermaidZoomableView svg={svg} mode="fullscreen" />
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("markdown.mermaid.closeFullscreen")}
            hitSlop={8}
            onPress={onClose}
            style={closeButtonStyle}
          >
            <ThemedX size={16} uniProps={mutedIconColorMapping} />
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0, 0, 0, 0.72)",
  },
  contentLayer: {
    ...StyleSheet.absoluteFillObject,
    pointerEvents: "box-none",
  },
  diagramArea: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
    pointerEvents: "box-none",
  },
  closeButton: {
    position: "absolute",
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
    zIndex: 1,
  },
}));

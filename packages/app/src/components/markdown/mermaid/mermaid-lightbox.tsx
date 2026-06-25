import { useCallback, useEffect, useMemo } from "react";
import { Modal, Pressable, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { isWeb } from "@/constants/platform";
import { MermaidZoomableView } from "@/components/markdown/mermaid/mermaid-zoomable-view";

interface MermaidLightboxProps {
  svg: string | null;
  onClose: () => void;
}

export function MermaidLightbox({ svg, onClose }: MermaidLightboxProps) {
  const { theme } = useUnistyles();
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
        top: insets.top + theme.spacing[3],
        right: insets.right + theme.spacing[3],
      },
    ],
    [insets.right, insets.top, theme.spacing],
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
          <MermaidZoomableView svg={svg} style={styles.diagramArea} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("markdown.mermaid.closeFullscreen")}
            hitSlop={8}
            onPress={onClose}
            style={closeButtonStyle}
          >
            <X size={16} color={theme.colors.foregroundMuted} />
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
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: theme.spacing[4],
  },
  diagramArea: {
    width: "100%",
    maxWidth: 960,
    maxHeight: "85%",
    justifyContent: "center",
    alignItems: "center",
  },
  closeButton: {
    position: "absolute",
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
  },
}));

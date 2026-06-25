import { View, Text } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import Animated, { useAnimatedStyle, withTiming, useSharedValue } from "react-native-reanimated";
import { useEffect, useMemo } from "react";
import { Upload } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { useFileDropZone, type DroppedItem } from "@/hooks/use-file-drop-zone";
import type { ImageAttachment } from "@/composer/types";
import { isWeb } from "@/constants/platform";

interface FileDropZoneProps {
  children: React.ReactNode;
  onFilesDropped: (files: ImageAttachment[]) => void;
  onGenericFilesDropped?: (items: DroppedItem[]) => void;
  onTextDropped?: (text: string) => void;
  disabled?: boolean;
}

const IS_WEB = isWeb;

export function FileDropZone({
  children,
  onFilesDropped,
  onGenericFilesDropped,
  onTextDropped,
  disabled = false,
}: FileDropZoneProps) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const { isDragging, containerRef } = useFileDropZone({
    onFilesDropped,
    onGenericFilesDropped,
    onTextDropped,
    disabled,
  });

  const overlayOpacity = useSharedValue(0);

  useEffect(() => {
    overlayOpacity.value = withTiming(isDragging ? 1 : 0, { duration: 150 });
  }, [isDragging, overlayOpacity]);

  const overlayAnimatedStyle = useAnimatedStyle(() => ({
    opacity: overlayOpacity.value,
    pointerEvents: overlayOpacity.value > 0 ? "auto" : "none",
  }));

  const overlayStyle = useMemo(
    () => [styles.overlay, overlayAnimatedStyle],
    [overlayAnimatedStyle],
  );

  // On non-web platforms, just render children.
  if (!IS_WEB) {
    return children;
  }

  return (
    <View
      // Cast ref for web - View renders as div on web.
      ref={containerRef as unknown as React.RefObject<View>}
      style={styles.container}
    >
      {children}

      <Animated.View style={overlayStyle}>
        <View style={styles.backdrop} />
        <View style={styles.overlayContent}>
          <Upload size={32} color={theme.colors.primary} />
          <Text style={styles.overlayText}>{t("composer.attachments.dropFilesHere")}</Text>
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    position: "relative",
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: theme.colors.surface0,
    opacity: 0.7,
  },
  overlayContent: {
    alignItems: "center",
    gap: theme.spacing[2],
  },
  overlayText: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
}));

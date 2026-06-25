import { View, Text } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import Animated, { useAnimatedStyle, withTiming, useSharedValue } from "react-native-reanimated";
import { useEffect, useMemo } from "react";
import { Upload } from "lucide-react-native";
import { useFileDropZone } from "@/hooks/use-file-drop-zone";
import type { ImageAttachment } from "@/composer/types";
import { isWeb } from "@/constants/platform";

interface FileDropZoneProps {
  children: React.ReactNode;
  onFilesDropped: (files: ImageAttachment[]) => void;
  onTextDropped?: (text: string) => void;
  disabled?: boolean;
}

const IS_WEB = isWeb;

export function FileDropZone({
  children,
  onFilesDropped,
  onTextDropped,
  disabled = false,
}: FileDropZoneProps) {
  const { theme } = useUnistyles();
  const { isDragging, containerRef } = useFileDropZone({
    onFilesDropped,
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

  // 非网页平台直接渲染子节点。
  if (!IS_WEB) {
    return children;
  }

  return (
    <View
      // 网页上 View 会渲染成 div，这里复用 DOM 引用。
      ref={containerRef as unknown as React.RefObject<View>}
      style={styles.container}
    >
      {children}

      <Animated.View style={overlayStyle}>
        <View style={styles.backdrop} />
        <View style={styles.overlayContent}>
          <Upload size={32} color={theme.colors.primary} />
          <Text style={styles.overlayText}>
            {onTextDropped ? "Drop files here" : "Drop images here"}
          </Text>
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

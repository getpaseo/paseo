import { View, Text, StyleSheet as RNStyleSheet } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import Animated, { useAnimatedStyle, withTiming } from "react-native-reanimated";
import { Upload } from "lucide-react-native";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { Theme } from "@/styles/theme";
import { useFileDropContext } from "./context";

const ThemedUpload = withUnistyles(Upload);
const primaryIconColorMapping = (theme: Theme) => ({ color: theme.colors.primary });

/**
 * Drop overlay rendered by FileDropZone. Reads `isDragging` on the UI thread so the dim
 * only ever repaints the backdrop — never the surrounding tree.
 */
export function FileDropBackdrop() {
  const { t } = useTranslation();
  const ctx = useFileDropContext();
  const isDragging = ctx?.isDragging;
  const suppressed = ctx?.suppressed;
  const hasSink = ctx?.hasSink;

  const animatedStyle = useAnimatedStyle(() => {
    const active = isDragging?.value && hasSink?.value && !suppressed?.value;
    return { opacity: withTiming(active ? 1 : 0, { duration: 150 }) };
  });

  const overlayStyle = useMemo(() => [positionStyles.overlay, animatedStyle], [animatedStyle]);

  if (!ctx) return null;

  // Animated.View keeps only plain-RN positioning; theme-dependent paint lives on the
  // non-animated children (applying themed Unistyles styles to an Animated.View crashes
  // on theme change — see docs/unistyles.md).
  return (
    <Animated.View style={overlayStyle} pointerEvents="none">
      <View style={styles.backdrop} />
      <View style={styles.content}>
        <ThemedUpload size={32} uniProps={primaryIconColorMapping} />
        <Text style={styles.text}>{t("composer.attachments.dropFilesHere")}</Text>
      </View>
    </Animated.View>
  );
}

const positionStyles = RNStyleSheet.create({
  overlay: {
    ...RNStyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
  },
});

const styles = StyleSheet.create((theme) => ({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: theme.colors.surface0,
    opacity: 0.7,
  },
  content: {
    alignItems: "center",
    gap: theme.spacing[2],
  },
  text: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
}));

import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { formatTextZoom, type TextZoomSurface } from "./model";
import { useTextZoom, useTextZoomPinching } from "./store";

/** The surface's size, live, over the surface while a pinch on it is in progress. */
export function TextZoomPreviewBadge({ surface }: { surface: TextZoomSurface }) {
  const pinching = useTextZoomPinching(surface);
  const zoom = useTextZoom(surface);
  if (!pinching) return null;
  return (
    <View pointerEvents="none" style={styles.layer}>
      <View style={styles.badge}>
        <Text style={styles.label}>{formatTextZoom(zoom)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  layer: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  badge: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  label: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
    fontVariant: ["tabular-nums"],
  },
}));

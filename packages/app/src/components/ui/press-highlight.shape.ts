import { StyleSheet, type StyleProp, type ViewStyle } from "react-native";

/**
 * A press highlight is drawn as an overlay inside the pressable rather than as a background on
 * it, because the node Reanimated animates cannot also carry the caller's themed style. An
 * overlay inherits nothing, so a rounded row gets a square flash unless the corners are copied
 * across.
 *
 * They are copied from the row's own style, not asked for again: the row already declares its
 * shape once, and a highlight that had to restate it would be a second copy free to drift. That
 * leaves `highlightStyle` to mean only what the highlight is painted with.
 */
const CORNER_PROPERTIES = [
  "borderRadius",
  "borderTopLeftRadius",
  "borderTopRightRadius",
  "borderBottomLeftRadius",
  "borderBottomRightRadius",
  "borderStartStartRadius",
  "borderStartEndRadius",
  "borderEndStartRadius",
  "borderEndEndRadius",
] as const;

/**
 * The corner radii a pressable's own style gives its highlight. A style resolved per press state
 * is left alone — its shape is not knowable before the press it describes, and every corner it
 * could name is one the caller can still set through `highlightStyle`.
 */
export function resolveHighlightCorners(
  style: StyleProp<ViewStyle> | ((state: never) => StyleProp<ViewStyle>) | undefined,
): ViewStyle {
  if (typeof style === "function") {
    return {};
  }
  const flattened = StyleSheet.flatten(style);
  if (!flattened) {
    return {};
  }
  const corners: ViewStyle = {};
  for (const property of CORNER_PROPERTIES) {
    const value = flattened[property];
    if (value !== undefined) {
      corners[property] = value;
    }
  }
  return corners;
}

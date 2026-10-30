import { useMemo } from "react";
import { type StyleProp, Text, type TextStyle, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ProjectIconImage } from "@/components/project-icon-image";
import { deriveIdentityColorName, identityColor } from "@/styles/identity-colors";

/**
 * Corner radius of the *generated* project icon — the colored square with an initial — as a
 * fraction of the box, so it reads as the same shape at 16pt in the sidebar and 40pt in the edit
 * sheet. Fixed tokens did not give that: the radius scale is coarse at the bottom, so small icons
 * landed on 2pt and looked square while large ones were visibly rounder.
 *
 * Uploaded artwork keeps its own silhouette unless the selected theme explicitly supplies a
 * project-icon radius. The default only rounds our generated initial tile.
 */
const RADIUS_RATIO = 0.25;

export function projectIconRadius(size: number): number {
  return Math.round(size * RADIUS_RATIO);
}

/**
 * A project's icon: its chosen image, or a colored square carrying its initial.
 *
 * Geometry lives here, not at the call site. It used to be five copies of the same
 * width/height/radius/centering block, which is how the radius drifted apart in the first
 * place — pass a `size` and the shape follows.
 */

export function ProjectIconView({
  iconDataUri,
  initial,
  projectViewKey,
  size,
  textStyle,
}: {
  iconDataUri: string | null;
  initial: string;
  projectViewKey: string;
  size: number;
  textStyle: StyleProp<TextStyle>;
}) {
  const box = useMemo(() => styles.image(size), [size]);
  const fallbackStyles = useMemo(
    () => styles.fallback(size, identityColor(deriveIdentityColorName(projectViewKey))),
    [size, projectViewKey],
  );
  const textStyles = useMemo(() => [textStyle, styles.text], [textStyle]);

  const fallback = useMemo(
    () => (
      <View style={fallbackStyles}>
        <Text style={textStyles}>{initial}</Text>
      </View>
    ),
    [fallbackStyles, initial, textStyles],
  );

  return iconDataUri ? (
    <ProjectIconImage dataUri={iconDataUri} fallback={fallback} style={box} />
  ) : (
    fallback
  );
}

const styles = StyleSheet.create((theme) => ({
  image: (size: number) => ({
    width: size,
    height: size,
    borderRadius: theme.components.projectIcon.radius ?? 0,
    backgroundColor: theme.components.projectIcon.background,
    borderWidth: theme.components.projectIcon.borderWidth ?? 0,
    borderColor: theme.components.projectIcon.borderColor ?? "transparent",
  }),
  fallback: (size: number, identity: string) => ({
    width: size,
    height: size,
    borderRadius: theme.components.projectIcon.radius ?? projectIconRadius(size),
    backgroundColor: theme.components.projectIcon.background ?? identity,
    borderWidth: theme.components.projectIcon.borderWidth ?? 0,
    borderColor: theme.components.projectIcon.borderColor ?? "transparent",
    alignItems: "center",
    justifyContent: "center",
  }),
  text: { color: theme.components.projectIcon.foreground ?? "#ffffff" },
}));

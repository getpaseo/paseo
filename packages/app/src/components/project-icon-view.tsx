import { useMemo } from "react";
import { Image, type ImageStyle, type StyleProp, View, type ViewStyle } from "react-native";
import { withUnistyles } from "react-native-unistyles";
import { Folder, FolderOpen } from "lucide-react-native";
import type { Theme } from "@/styles/theme";
import { ICON_SIZE } from "@/styles/theme";

const ThemedFolder = withUnistyles(Folder);
const ThemedFolderOpen = withUnistyles(FolderOpen);

const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

export function ProjectIconView({
  iconDataUri,
  imageStyle,
  fallbackStyle,
  expanded = false,
  iconSize = ICON_SIZE.sm,
}: {
  iconDataUri: string | null;
  imageStyle: StyleProp<ImageStyle>;
  fallbackStyle: StyleProp<ViewStyle>;
  /** When true, uses an open folder glyph (sidebar expand/collapse). */
  expanded?: boolean;
  /** Outline glyph size when there is no project image. */
  iconSize?: number;
}) {
  const imageSource = useMemo(() => ({ uri: iconDataUri ?? "" }), [iconDataUri]);

  if (iconDataUri) {
    return <Image source={imageSource} style={imageStyle} />;
  }

  return (
    <View style={fallbackStyle}>
      {expanded ? (
        <ThemedFolderOpen size={iconSize} uniProps={foregroundMutedColorMapping} />
      ) : (
        <ThemedFolder size={iconSize} uniProps={foregroundMutedColorMapping} />
      )}
    </View>
  );
}

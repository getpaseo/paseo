import { useMemo } from "react";
import {
  Image,
  type ImageStyle,
  type StyleProp,
  Text,
  type TextStyle,
  View,
  type ViewStyle,
} from "react-native";
import type { ProjectAppearance } from "@getpaseo/protocol/messages";
import { deriveProjectIconColor, projectIconTextColor } from "@/projects/icon-colors";

export function ProjectIconView({
  iconDataUri,
  initial,
  projectViewKey,
  appearance,
  imageStyle,
  fallbackStyle,
  textStyle,
}: {
  iconDataUri: string | null;
  initial: string;
  projectViewKey: string;
  appearance?: ProjectAppearance | null;
  imageStyle: StyleProp<ImageStyle>;
  fallbackStyle: StyleProp<ViewStyle>;
  textStyle: StyleProp<TextStyle>;
}) {
  const imageSource = useMemo(() => ({ uri: iconDataUri ?? "" }), [iconDataUri]);
  const backgroundColor = appearance?.color ?? deriveProjectIconColor(projectViewKey);
  const label = appearance?.icon.type === "custom" ? appearance.icon.text : initial;
  const fallbackStyles = useMemo(
    () => [fallbackStyle, { backgroundColor }],
    [backgroundColor, fallbackStyle],
  );
  const textStyles = useMemo(
    () => [
      textStyle,
      backgroundColor === "transparent" ? null : { color: projectIconTextColor(backgroundColor) },
    ],
    [backgroundColor, textStyle],
  );

  if (iconDataUri) {
    return <Image source={imageSource} style={imageStyle} />;
  }
  return (
    <View style={fallbackStyles}>
      <Text adjustsFontSizeToFit numberOfLines={1} style={textStyles}>
        {label}
      </Text>
    </View>
  );
}

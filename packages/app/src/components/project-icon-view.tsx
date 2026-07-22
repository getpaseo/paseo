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
import { deriveProjectIconColor } from "@/utils/project-icon-color";

function textColor(backgroundColor: string): string {
  const value = backgroundColor.replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(value)) return "#ffffff";
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return red * 299 + green * 587 + blue * 114 > 160_000 ? "#000000" : "#ffffff";
}

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
      backgroundColor === "transparent" ? null : { color: textColor(backgroundColor) },
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

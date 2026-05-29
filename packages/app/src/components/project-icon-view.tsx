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
import { deriveProjectIconColor } from "@/utils/project-icon-color";

const WHITE_TEXT = { color: "#ffffff" } as const;

export function ProjectIconView({
  iconDataUri,
  initial,
  projectKey,
  imageStyle,
  fallbackStyle,
  textStyle,
}: {
  iconDataUri: string | null;
  initial: string;
  projectKey: string;
  imageStyle: StyleProp<ImageStyle>;
  fallbackStyle: StyleProp<ViewStyle>;
  textStyle: StyleProp<TextStyle>;
}) {
  const imageSource = useMemo(() => ({ uri: iconDataUri ?? "" }), [iconDataUri]);
  const fallbackStyles = useMemo(
    () => [fallbackStyle, { backgroundColor: deriveProjectIconColor(projectKey) }],
    [fallbackStyle, projectKey],
  );
  const textStyles = useMemo(() => [textStyle, WHITE_TEXT], [textStyle]);

  if (iconDataUri) {
    return <Image source={imageSource} style={imageStyle} />;
  }
  return (
    <View style={fallbackStyles}>
      <Text style={textStyles}>{initial}</Text>
    </View>
  );
}

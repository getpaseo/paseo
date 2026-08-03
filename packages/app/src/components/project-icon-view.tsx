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
import { deriveIdentityColorName, identityColor } from "@/styles/identity-colors";

const WHITE_TEXT = { color: "#ffffff" } as const;

export function ProjectIconView({
  iconDataUri,
  initial,
  projectViewKey,
  imageStyle,
  fallbackStyle,
  textStyle,
}: {
  iconDataUri: string | null;
  initial: string;
  projectViewKey: string;
  imageStyle: StyleProp<ImageStyle>;
  fallbackStyle: StyleProp<ViewStyle>;
  textStyle: StyleProp<TextStyle>;
}) {
  const imageSource = useMemo(() => ({ uri: iconDataUri ?? "" }), [iconDataUri]);
  const fallbackStyles = useMemo(
    () => [
      fallbackStyle,
      { backgroundColor: identityColor(deriveIdentityColorName(projectViewKey)) },
    ],
    [fallbackStyle, projectViewKey],
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

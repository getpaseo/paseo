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
import { projectIconEmojiFromDataUri } from "@/utils/project-icon-presentation";

const WHITE_TEXT = { color: "#ffffff" } as const;

export function ProjectIconView({
  iconDataUri,
  initial,
  projectKey,
  imageStyle,
  fallbackStyle,
  textStyle,
  emojiStyle,
}: {
  iconDataUri: string | null;
  initial: string;
  projectKey: string;
  imageStyle: StyleProp<ImageStyle>;
  fallbackStyle: StyleProp<ViewStyle>;
  textStyle: StyleProp<TextStyle>;
  emojiStyle: StyleProp<TextStyle>;
}) {
  const emoji = projectIconEmojiFromDataUri(iconDataUri);
  const imageSource = useMemo(() => ({ uri: iconDataUri ?? "" }), [iconDataUri]);
  const fallbackStyles = useMemo(
    () => [fallbackStyle, { backgroundColor: deriveProjectIconColor(projectKey) }],
    [fallbackStyle, projectKey],
  );
  const textStyles = useMemo(() => [textStyle, WHITE_TEXT], [textStyle]);

  if (emoji) {
    return (
      <View style={fallbackStyle}>
        <Text allowFontScaling={false} style={emojiStyle}>
          {emoji}
        </Text>
      </View>
    );
  }
  if (iconDataUri) {
    return <Image source={imageSource} style={imageStyle} />;
  }
  return (
    <View style={fallbackStyles}>
      <Text style={textStyles}>{initial}</Text>
    </View>
  );
}

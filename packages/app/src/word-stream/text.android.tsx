import { createContext, useContext } from "react";
import { StyleSheet, Text, type TextProps } from "react-native";
import { useWordFadeSurface } from ".";
import { WordFadeHost } from "./native-host";
import { hostTextStyle } from "./internal/host-style";

const TextAncestor = createContext(false);

export function WordFadeText(props: TextProps) {
  const nested = useContext(TextAncestor);
  const surface = useWordFadeSurface();
  if (nested) return <Text {...props} />;
  const style = hostTextStyle(StyleSheet.flatten(props.style) ?? {});
  return (
    <TextAncestor value={true}>
      <WordFadeHost ranges={surface.ranges} style={style.host}>
        <Text {...props} style={style.text} />
      </WordFadeHost>
    </TextAncestor>
  );
}

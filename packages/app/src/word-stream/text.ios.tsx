import { createContext, useContext } from "react";
import { StyleSheet, type TextProps } from "react-native";
import { UITextView } from "react-native-uitextview";
import { useWordFadeSurface } from ".";
import { WordFadeHost } from "./native-host";
import { hostTextStyle } from "./internal/host-style";

const TextAncestor = createContext(false);

export function WordFadeText(props: TextProps) {
  const nested = useContext(TextAncestor);
  const surface = useWordFadeSurface();
  if (nested) return <UITextView {...props} uiTextView selectable />;
  const style = hostTextStyle(StyleSheet.flatten(props.style) ?? {});
  return (
    <TextAncestor value={true}>
      <WordFadeHost ranges={surface.ranges} style={style.host}>
        <UITextView {...props} uiTextView selectable style={style.text} />
      </WordFadeHost>
    </TextAncestor>
  );
}

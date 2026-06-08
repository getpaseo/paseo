import { StyleSheet, type StyleProp, type TextStyle } from "react-native";

export function resolvePlainMarkdownTextStyle(style: StyleProp<TextStyle>): TextStyle {
  return stripUnistylesMetadata(StyleSheet.flatten(style) ?? {});
}

function stripUnistylesMetadata(style: TextStyle): TextStyle {
  // iOS markdown text goes through react-native-uitextview. That library
  // inherits text styles by flattening [parentStyle, childStyle] before handing
  // the result to native View-backed components. If both entries are Unistyles
  // styles, flattening preserves both `unistyles_*` metadata keys in one object,
  // and Unistyles correctly warns that the style should have stayed array-shaped.
  //
  // `UITextView` is a third-party boundary, not a Unistyles-tracked component in
  // our ownership model. Resolve the concrete style values before crossing that
  // boundary and drop only Unistyles' private tracking metadata. This preserves
  // iOS paragraph/spanning text selection while avoiding the metadata merge.
  const plainStyle: Record<string, unknown> = { ...style };
  for (const key of Object.keys(plainStyle)) {
    if (key.startsWith("unistyles_")) {
      delete plainStyle[key];
    }
  }
  return plainStyle as TextStyle;
}

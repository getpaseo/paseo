import type { TextStyle, ViewStyle } from "react-native";

export const MAX_PREVIEW_HEIGHT = 480;

export function getDiagramBoxStyle(style: TextStyle): ViewStyle {
  return {
    backgroundColor: style.backgroundColor,
    borderColor: style.borderColor,
    borderRadius: style.borderRadius,
    borderWidth: style.borderWidth,
    marginBottom: style.marginBottom,
    marginTop: style.marginTop,
    marginVertical: style.marginVertical,
    padding: style.padding,
  };
}

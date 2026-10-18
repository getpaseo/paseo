import type { TextStyle, ViewStyle } from "react-native";

export function getDiagramBoxStyle(style: TextStyle): ViewStyle {
  return {
    backgroundColor: style.backgroundColor,
    borderColor: style.borderColor,
    borderRadius: style.borderRadius,
    borderWidth: style.borderWidth,
    padding: style.padding,
  };
}

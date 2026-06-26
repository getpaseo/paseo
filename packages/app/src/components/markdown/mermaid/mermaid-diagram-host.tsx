import { View, type StyleProp, type ViewStyle } from "react-native";

export type MermaidDiagramHostLayout = "intrinsic" | "fill";

export interface MermaidDiagramHostProps {
  svg: string;
  style?: StyleProp<ViewStyle>;
  layout?: MermaidDiagramHostLayout;
}

export function MermaidDiagramHost({ svg: _svg, style }: MermaidDiagramHostProps) {
  return <View style={style} />;
}

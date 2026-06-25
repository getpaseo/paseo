import { View, type StyleProp, type ViewStyle } from "react-native";

interface MermaidDiagramHostProps {
  svg: string;
  style?: StyleProp<ViewStyle>;
}

export function MermaidDiagramHost({ svg: _svg, style }: MermaidDiagramHostProps) {
  return <View style={style} />;
}

import { ActivityIndicator, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

interface MermaidDiagramViewProps {
  source: string;
  onSvgChange?: (svg: string | null) => void;
}

/** Native WebView rendering lands in a follow-up commit with the bundled HTML asset. */
export function MermaidDiagramView(_props: MermaidDiagramViewProps) {
  return (
    <View style={diagramStyles.pendingWrap}>
      <ActivityIndicator />
    </View>
  );
}

const diagramStyles = StyleSheet.create((theme) => ({
  pendingWrap: {
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[3],
  },
}));

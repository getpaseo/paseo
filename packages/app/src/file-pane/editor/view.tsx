import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { HighlightStyle } from "@getpaseo/highlight";
import type { FileEditorModel } from "./model";

export function FileEditorView(_props: {
  model: FileEditorModel;
  filename: string;
  vimEnabled: boolean;
  theme: {
    background: string;
    foreground: string;
    foregroundMuted: string;
    border: string;
    selection: string;
    monoFont: string;
    codeFontSize: number;
    syntax: Record<HighlightStyle, string>;
  };
  onCursorChange(position: { line: number; column: number }): void;
  onVimModeChange(mode: string | null): void;
}) {
  return (
    <View style={styles.container}>
      <Text style={styles.text}>Source editing is available on web and desktop.</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, alignItems: "center", justifyContent: "center" },
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));

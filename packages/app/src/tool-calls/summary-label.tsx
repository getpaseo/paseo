import React, { useCallback } from "react";
import { Text, View, type GestureResponderEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";

interface ToolCallSummaryLabelProps {
  input: string;
  output?: string;
  inputFilePath?: string;
  outputFilePath?: string;
  onOpenFilePath?: (path: string) => void;
}

function compactLabel(text: string): string {
  const words = text.trim().split(/\s+/);
  return words.length > 8 ? `${words.slice(0, 8).join(" ")}…` : text;
}

interface LinkedLabelProps {
  text: string;
  filePath?: string;
  onOpenFilePath?: (path: string) => void;
}

function LinkedLabel({ text, filePath, onOpenFilePath }: LinkedLabelProps) {
  const filename = filePath?.replace(/\\/g, "/").split("/").pop();
  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      if (filePath) onOpenFilePath?.(filePath);
    },
    [filePath, onOpenFilePath],
  );
  const label = compactLabel(filePath && filename ? text.replaceAll(filePath, filename) : text);
  const start = filename ? label.indexOf(filename) : -1;
  if (!filename || !onOpenFilePath || start < 0) return label;
  return (
    <>
      {label.slice(0, start)}
      <Text
        style={styles.fileLink}
        accessibilityRole="link"
        accessibilityLabel={filePath}
        onPress={handlePress}
      >
        {filename}
      </Text>
      {label.slice(start + filename.length)}
    </>
  );
}

export function ToolCallSummaryLabel({
  input,
  output,
  inputFilePath,
  outputFilePath,
  onOpenFilePath,
}: ToolCallSummaryLabelProps) {
  return (
    <View style={styles.row} testID="tool-call-summary-label">
      <Text
        style={[styles.input, output ? styles.inputWithOutput : undefined]}
        numberOfLines={1}
        testID="tool-call-input-label"
      >
        <LinkedLabel text={input} filePath={inputFilePath} onOpenFilePath={onOpenFilePath} />
      </Text>
      {output ? (
        <>
          <Text style={styles.arrow} accessibilityElementsHidden>
            →
          </Text>
          <Text style={styles.output} numberOfLines={1} testID="tool-call-output-label">
            <LinkedLabel text={output} filePath={outputFilePath} onOpenFilePath={onOpenFilePath} />
          </Text>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center" },
  input: {
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  inputWithOutput: { maxWidth: "55%" },
  output: {
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  arrow: {
    color: theme.colors.foregroundMuted,
    marginHorizontal: theme.spacing[2],
    fontSize: theme.fontSize.base,
  },
  fileLink: { textDecorationLine: "underline" },
}));

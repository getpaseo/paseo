import { ScrollView, Text } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { HighlightedCodeBlock } from "@/components/highlighted-code-block";
import type { Theme } from "@/styles/theme";

const ThemedHighlightedCodeBlock = withUnistyles(HighlightedCodeBlock);

const codeBlockStyles = (theme: Theme) => ({
  inheritedStyles: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
  },
  textStyle: {
    backgroundColor: theme.colors.surface2,
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
  },
});

export function FileHtmlPreview({ html, testID }: { html: string; testID?: string }) {
  return (
    <ScrollView testID={testID}>
      <Text style={styles.notice}>HTML rendering is not available in GPUI. Showing source.</Text>
      <ThemedHighlightedCodeBlock code={html} language="html" uniProps={codeBlockStyles} />
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  notice: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginBottom: theme.spacing[2],
  },
}));

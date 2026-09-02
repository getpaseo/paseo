import { useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { MAX_CONTENT_WIDTH } from "@/constants/layout";
import { parseMarkdownPreviewDocument } from "./document";

export function FileMarkdownPreview({ source }: { source: string }) {
  const document = useMemo(() => parseMarkdownPreviewDocument(source), [source]);

  return (
    <View style={styles.outerGutter}>
      <View style={styles.readingFrame}>
        {document.frontMatter.length > 0 ? (
          <View style={styles.frontMatterTable} testID="markdown-front-matter">
            {document.frontMatter.map((row, index) => (
              <View
                key={row.key}
                style={[styles.frontMatterRow, index > 0 && styles.frontMatterRowBorder]}
              >
                <View style={styles.frontMatterKeyCell}>
                  <Text selectable style={styles.frontMatterKey}>
                    {row.key}
                  </Text>
                </View>
                <View style={styles.frontMatterValueCell}>
                  <Text selectable style={styles.frontMatterValue}>
                    {row.value}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        ) : null}
        <MarkdownRenderer text={document.body} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  outerGutter: {
    width: "100%",
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[4],
    },
    paddingVertical: theme.spacing[4],
  },
  readingFrame: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
    alignSelf: "center",
    paddingHorizontal: theme.spacing[2],
  },
  frontMatterTable: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
    marginBottom: theme.spacing[6],
  },
  frontMatterRow: {
    flexDirection: "row",
    alignItems: "stretch",
  },
  frontMatterRowBorder: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  frontMatterKeyCell: {
    flexBasis: "30%",
    maxWidth: 180,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface2,
  },
  frontMatterValueCell: {
    flex: 1,
    minWidth: 0,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  frontMatterKey: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.base,
    lineHeight: 20,
  },
  frontMatterValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: 20,
  },
}));

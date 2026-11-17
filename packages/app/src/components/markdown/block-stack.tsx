import { useMemo, type ReactNode } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { markdownCopyImageSourcesDataSet } from "@/assistant-selection-copy/markup";
import { isWeb } from "@/constants/platform";
import { density } from "@/styles/density";
import { MARKDOWN_DOCUMENT_DATASET } from "./document";

/** Stacks Markdown blocks rendered as separate views with the same gap the text puts between its blocks. */
export function MarkdownBlockStack({
  imageSources,
  children,
}: {
  imageSources?: Record<string, string>;
  children: ReactNode;
}) {
  const dataSet = useMemo(
    () => ({
      ...MARKDOWN_DOCUMENT_DATASET,
      ...(isWeb && imageSources ? markdownCopyImageSourcesDataSet(imageSources) : null),
    }),
    [imageSources],
  );
  return (
    <View style={styles.stack} dataSet={dataSet}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: density.blockGap },
});

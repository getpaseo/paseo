import type { ReactNode } from "react";
import { ScrollView, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { MarkdownParagraphView } from "@/components/markdown-text";

export function AssistantImageGallery({
  children,
  paragraphStyle,
}: {
  children: ReactNode[];
  paragraphStyle: ViewStyle;
}) {
  return (
    <MarkdownParagraphView paragraphStyle={paragraphStyle} containsImage>
      <ScrollView
        horizontal
        nestedScrollEnabled
        showsHorizontalScrollIndicator={false}
        style={styles.viewport}
        contentContainerStyle={styles.content}
        testID="assistant-image-gallery"
      >
        {children}
      </ScrollView>
    </MarkdownParagraphView>
  );
}

const styles = StyleSheet.create((theme) => ({
  viewport: {
    flex: 1,
    minWidth: 0,
  },
  content: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
    paddingRight: theme.spacing[1],
  },
}));

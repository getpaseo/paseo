import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { Button, ScrollView, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { MarkdownRenderer } from "@/components/markdown/renderer";

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1 },
  scroll: { backgroundColor: theme.colors.surface0 },
  content: { padding: 32, paddingTop: 60 },
  title: { color: theme.colors.foreground },
}));

const queryClient = new QueryClient();

const source = [
  "Plain: `MMMMiiii`",
  "Bold: **`MMMMiiii`**",
  "Italic: *`MMMMiiii`*",
  "Both: ***`MMMMiiii`***",
  "Strike: ~~`MMMMiiii`~~",
  "Link: [`MMMMiiii`](https://example.com)",
  "# Heading **`MMMMiiii`**",
  "## Heading *`MMMMiiii`*",
  "### Heading [`MMMMiiii`](https://example.com)",
  "#### Heading ~~`MMMMiiii`~~",
  "##### Heading ***`MMMMiiii`***",
  "###### Heading `MMMMiiii`",
  "- List **`MMMMiiii`**",
  "> Quote **`MMMMiiii`**",
  "Normal **bold** and *italic* prose.",
].join("\n\n");

export default function MarkdownFormattingRegression() {
  const [compact, setCompact] = useState(false);
  const toggleCompact = useCallback(() => setCompact((value) => !value), []);
  return (
    <QueryClientProvider client={queryClient}>
      <GestureHandlerRootView style={styles.root}>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
          <Text style={styles.title}>Inline code formatting regression</Text>
          <Button
            title={compact ? "Use regular text" : "Use compact text"}
            onPress={toggleCompact}
          />
          <MarkdownRenderer text={source} compact={compact} />
        </ScrollView>
      </GestureHandlerRootView>
    </QueryClientProvider>
  );
}

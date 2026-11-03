import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { Button, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { MarkdownRenderer } from "@/components/markdown/renderer";

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1 },
  scroll: { backgroundColor: theme.colors.surface0 },
  content: { padding: 32, paddingTop: 60 },
  title: { color: theme.colors.foreground },
  wrapping: { width: 300 },
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

const wrappingSource = [
  "Measurement parity. Take a repo with a gitignored `.env` in the main checkout and a `.worktreeinclude` containing `.env`.",
  "Every creation path goes through `createPaseoWorktreeWorkflow` in `worktree-session.ts:341`, before `createAgent` in `creation/index.ts:160-174` starts.",
  "The built-in plugin lives in `plugins/worktree-include/index.server.ts` and copies `paseo.json` beside `.worktreeinclude`. End of measurement fixture.",
].join("\n\n");

export default function MarkdownFormattingRegression() {
  const [wrapping, setWrapping] = useState(false);
  const toggleWrapping = useCallback(() => setWrapping((value) => !value), []);
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
          <Button
            title={wrapping ? "Show formatting fixture" : "Show wrapping fixture"}
            onPress={toggleWrapping}
          />
          <View style={wrapping ? styles.wrapping : undefined}>
            <MarkdownRenderer text={wrapping ? wrappingSource : source} compact={compact} />
          </View>
          <Text style={styles.title}>End of Markdown host</Text>
        </ScrollView>
      </GestureHandlerRootView>
    </QueryClientProvider>
  );
}

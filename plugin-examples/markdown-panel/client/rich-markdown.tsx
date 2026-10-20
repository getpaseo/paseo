import {
  PluginFileConflictError,
  PluginFileDeletedError,
  type PluginFilePanelProps,
  useFileText,
} from "@getpaseo/plugin/client";
import { Loading } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { type MarkdownEditorHandle, mountEditor } from "./web";

const SAVE_DELAY_MS = 500;

type EditorState = "loading" | "ready" | "conflict" | "deleted";

/**
 * Reads the file once, writes 500 ms after the last edit, and follows the disk while nothing is
 * unsaved. With unsaved edits, a change on disk is a conflict: Reload or Overwrite.
 */
function MarkdownEditor({ file, tab, theme }: PluginFilePanelProps) {
  const parent = useRef<View>(null);
  const editor = useRef<MarkdownEditorHandle | null>(null);
  const text = useRef("");
  const unsaved = useRef<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [state, setState] = useState<EditorState>("loading");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      text.current = await file.readText();
    } catch (cause) {
      setError(messageOf(cause));
      return;
    }
    unsaved.current = null;
    tab.setModified(false);
    editor.current?.setText(text.current);
    setError(null);
    setState("ready");
  }, [file, tab]);

  const save = useCallback(
    async (force: boolean) => {
      const next = unsaved.current;
      if (next === null) return;
      try {
        await file.writeText(next, { force });
      } catch (cause) {
        if (cause instanceof PluginFileConflictError) setState("conflict");
        else if (cause instanceof PluginFileDeletedError) setState("deleted");
        else setError(messageOf(cause));
        return;
      }
      if (unsaved.current === next) {
        unsaved.current = null;
        tab.setModified(false);
      }
      setError(null);
      setState("ready");
    },
    [file, tab],
  );

  useLayoutEffect(() => {
    editor.current = mountEditor(parent.current, text.current, theme, (next) => {
      text.current = next;
      unsaved.current = next;
      tab.setModified(true);
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void save(false), SAVE_DELAY_MS);
    });
    return () => {
      editor.current?.destroy();
      editor.current = null;
    };
  }, [save, tab, theme]);

  useEffect(() => {
    void load();
    const unwatch = file.watch((event) => {
      if (event.type === "deleted") setState("deleted");
      else if (unsaved.current === null) void load();
      else setState("conflict");
    });
    return () => {
      unwatch();
      clearTimeout(saveTimer.current);
      // Switching panels keeps the edit. Closing the tab asks first and drops it if discarded.
      // The panel is gone, so a failed write (a conflict, a lost connection) can only be reported.
      if (unsaved.current !== null) {
        void file.writeText(unsaved.current).catch((cause) => {
          console.warn(`Unsaved edits to ${file.name} were not written: ${messageOf(cause)}`);
        });
      }
    };
  }, [file, load]);

  const styles = useMemo(
    () => ({
      panel: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 },
      editor: { flex: 1, minHeight: 0 },
      banner: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 12,
        paddingHorizontal: 16,
        paddingVertical: 8,
        backgroundColor: theme.colors.surface1,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      },
      bannerText: { flex: 1, color: theme.colors.foreground },
      error: { color: theme.colors.statusDanger, paddingHorizontal: 16, paddingVertical: 8 },
      action: { color: theme.colors.accent },
    }),
    [theme],
  );
  const overwrite = useCallback(() => void save(true), [save]);
  const reload = useCallback(() => void load(), [load]);

  return (
    <View style={styles.panel}>
      {state === "conflict" ? (
        <View style={styles.banner} testID="rich-markdown-conflict">
          <Text style={styles.bannerText}>The file changed on disk.</Text>
          <Pressable accessibilityRole="button" onPress={reload}>
            <Text style={styles.action}>Reload</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={overwrite}>
            <Text style={styles.action}>Overwrite</Text>
          </Pressable>
        </View>
      ) : null}
      {state === "deleted" ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>The file was deleted. Edits are kept here.</Text>
        </View>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View ref={parent} style={styles.editor} />
      {state === "loading" && !error ? <Loading /> : null}
    </View>
  );
}

/** Native has no editor: selectable, read-only text that follows the disk. */
function MarkdownText({ file, theme }: PluginFilePanelProps) {
  const text = useFileText(file);
  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      text: { color: theme.colors.foreground, padding: 16 },
      error: { color: theme.colors.statusDanger, padding: 16 },
    }),
    [theme],
  );
  if (text.status === "loading") return <Loading />;
  if (text.status === "error") return <Text style={styles.error}>{text.error.message}</Text>;
  return (
    <ScrollView style={styles.screen}>
      <Text selectable style={styles.text}>
        {text.text}
      </Text>
    </ScrollView>
  );
}

export function RichMarkdownPanel(props: PluginFilePanelProps) {
  if (props.layout.platform === "web") return <MarkdownEditor {...props} />;
  return <MarkdownText {...props} />;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

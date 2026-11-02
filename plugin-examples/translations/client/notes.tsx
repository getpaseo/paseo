import { useCallback, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Modal, TextInput, ScrollView } from "@getpaseo/plugin/client/ui";
import { useTranslation, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { messages } from "./messages";

function useStyles(theme: PluginSurfaceProps["theme"], compact: boolean) {
  return useMemo(() => {
    const primary = { padding: 12, borderRadius: 8, backgroundColor: theme.colors.accent };
    return StyleSheet.create({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: {
        padding: compact ? 20 : 36,
        gap: 20,
        width: "100%",
        maxWidth: 760,
        alignSelf: "center",
      },
      heading: { gap: 8 },
      title: { color: theme.colors.foreground, fontSize: 28, fontWeight: "600" },
      text: { color: theme.colors.foreground },
      muted: { color: theme.colors.foregroundMuted },
      label: { color: theme.colors.foreground, fontWeight: "600" },
      card: {
        gap: 12,
        padding: 20,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      },
      input: {
        color: theme.colors.foreground,
        minHeight: 112,
        padding: 12,
        borderRadius: 8,
        borderColor: theme.colors.border,
        borderWidth: 1,
        backgroundColor: theme.colors.surface0,
      },
      actions: { flexDirection: "row", gap: 12, flexWrap: "wrap" },
      primary,
      primaryDisabled: { ...primary, opacity: 0.5 },
      primaryText: { color: theme.colors.accentForeground },
      secondary: { padding: 12, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border },
      preview: { gap: 16 },
      close: { padding: 12 },
      closeText: { color: theme.colors.accent },
    });
  }, [theme, compact]);
}

function Preview({
  draft,
  theme,
  close,
}: {
  draft: string;
  theme: PluginSurfaceProps["theme"];
  close(): void;
}) {
  // This hook also runs inside native portal hosts.
  const { t, locale } = useTranslation(messages);
  const styles = useStyles(theme, false);
  return (
    <View style={styles.preview}>
      <Text style={styles.text}>{draft || t("draftEmpty")}</Text>
      <Text style={styles.muted}>{t("locale", { locale })}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("close")}
        onPress={close}
        style={styles.close}
      >
        <Text style={styles.closeText}>{t("close")}</Text>
      </Pressable>
    </View>
  );
}

export function Notes({ theme, layout }: PluginSurfaceProps) {
  const { t, locale } = useTranslation(messages);
  const [draft, setDraft] = useState("");
  const [notes, setNotes] = useState<{ id: number; text: string }[]>([]);
  const [preview, setPreview] = useState(false);
  const styles = useStyles(theme, layout.compact);
  const showPreview = useCallback(() => setPreview(true), []);
  const closePreview = useCallback(() => setPreview(false), []);
  const addNote = useCallback(() => {
    setNotes((previous) => [...previous, { id: previous.length, text: draft }]);
    setDraft("");
  }, [draft]);
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.heading}>
        <Text style={styles.title}>{t("title")}</Text>
        <Text style={styles.muted}>{t("intro")}</Text>
      </View>
      <View style={styles.card}>
        <Text style={styles.label}>{t("draft")}</Text>
        <TextInput
          accessibilityLabel={t("draft")}
          placeholder={t("placeholder")}
          placeholderTextColor={theme.colors.foregroundMuted}
          value={draft}
          onChangeText={setDraft}
          multiline
          style={styles.input}
        />
        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("add")}
            disabled={!draft.trim()}
            onPress={addNote}
            style={draft.trim() ? styles.primary : styles.primaryDisabled}
          >
            <Text style={styles.primaryText}>{t("add")}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("preview")}
            onPress={showPreview}
            style={styles.secondary}
          >
            <Text style={styles.text}>{t("preview")}</Text>
          </Pressable>
        </View>
      </View>
      <Text style={styles.label}>{t("notes", { count: notes.length })}</Text>
      {notes.length === 0 ? (
        <Text style={styles.muted}>{t("empty")}</Text>
      ) : (
        notes.map((note) => (
          <Text key={note.id} style={styles.text}>
            {note.text}
          </Text>
        ))
      )}
      <View style={styles.heading}>
        <Text style={styles.muted}>{t("locale", { locale })}</Text>
        <Text style={styles.muted}>{t("fallback")}</Text>
      </View>
      <Modal title={t("previewTitle")} open={preview} onOpenChange={setPreview}>
        <Modal.Content>
          <Preview draft={draft} theme={theme} close={closePreview} />
        </Modal.Content>
      </Modal>
    </ScrollView>
  );
}

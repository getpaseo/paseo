import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useFileText } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { isWeb } from "@/constants/platform";
import { useAppSettings } from "@/hooks/use-settings";
import { confirmDialog } from "@/utils/confirm-dialog";
import { formatFileSize } from "@/utils/format-file-size";
import type { Theme } from "@/styles/theme";
import { FilePanelLoading } from "../loading";
import type { BuiltinFilePanelProps } from "../panels";
import { FileConflictAlert, type FileConflictAlertState } from "./conflict-alert";
import { FileEditorModel, getFileConflictCallout } from "./editor/model";
import { FileEditorView } from "./editor/view";
import { selectSourcePresentation } from "./readonly/presentation";
import { FileSourceView } from "./readonly/view";
import { SourceStatusRow } from "./status";

// CodeMirror and native source rendering consume appearance as props. Subscribe at the
// rendering leaf so theme updates reconfigure it without replacing the editor/model.
const sourceAppearance = (theme: Theme) => ({
  theme: {
    colorScheme: theme.colorScheme,
    background: theme.colors.surface0,
    foreground: theme.colors.foreground,
    cursor: theme.colors.terminal.cursor,
    foregroundMuted: theme.colors.foregroundMuted,
    border: theme.colors.border,
    selection: theme.colors.terminal.selectionBackground,
    monoFont: theme.fontFamily.mono,
    codeFontSize: theme.fontSize.code,
    syntax: theme.colors.syntax,
  },
});
const ThemedFileEditorView = withUnistyles(FileEditorView, sourceAppearance);
const ThemedFileSourceView = withUnistyles(FileSourceView, sourceAppearance);

/** The daemon refuses to write larger files. */
const MAX_EDITABLE_BYTES = 1024 * 1024;

/**
 * Paseo's editor for text files. Edits files up to 1 MiB on web; shows larger files and every file
 * on native read-only, and refuses files above the display budget before reading them.
 */
export function SourcePanel(props: BuiltinFilePanelProps) {
  const size = props.file.size;
  const presentation = selectSourcePresentation({ size, platform: isWeb ? "web" : "native" });
  if (presentation === "unsupported") return <TooLargeSource size={size} />;
  if (isWeb && size <= MAX_EDITABLE_BYTES) return <EditableSource {...props} />;
  return <ReadonlySource {...props} presentation={presentation} />;
}

function TooLargeSource({ size }: { size: number }) {
  const { t } = useTranslation();
  return (
    <View style={styles.centerState} testID="file-source-too-large">
      <Text style={styles.mutedText}>{t("panels.file.tooLargeToDisplay")}</Text>
      <Text style={styles.mutedText}>{formatFileSize(size)}</Text>
    </View>
  );
}

function ReadonlySource({
  file,
  location,
  target,
  presentation,
}: BuiltinFilePanelProps & { presentation: "highlighted" | "plain" }) {
  const text = useFileText(file);
  const { t } = useTranslation();
  const sourceLocation = useMemo(
    () => ({ path: target.path, lineStart: location.lineStart, lineEnd: location.lineEnd }),
    [location.lineEnd, location.lineStart, target.path],
  );
  if (text.status === "loading") return <FilePanelLoading />;
  if (text.status === "error") {
    return (
      <View style={styles.centerState}>
        <Text style={styles.errorText}>{text.error.message || t("panels.file.failedToLoad")}</Text>
      </View>
    );
  }
  return (
    <View style={styles.container}>
      <ThemedFileSourceView
        content={text.text}
        filename={target.path}
        location={sourceLocation}
        navigationRevision={location.revision}
        presentation={presentation}
      />
      <SourceStatusRow size={file.size} lineCount={text.text.split("\n").length} />
    </View>
  );
}

function EditableSource({ file, tab, location, target }: BuiltinFilePanelProps) {
  const { settings } = useAppSettings();
  const { t } = useTranslation();
  const [model] = useState(() => new FileEditorModel({ file }));
  const [editorReady, setEditorReady] = useState(false);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [vimMode, setVimMode] = useState<string | null>(settings.vimKeybindings ? "NORMAL" : null);
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);

  useEffect(() => {
    model.open();
    return () => model.dispose({ flush: true });
  }, [model]);
  useEffect(() => {
    tab.setModified(snapshot.modified);
  }, [snapshot.modified, tab]);

  const handleReload = useCallback(() => {
    if (!snapshot.modified) {
      void model.reload();
      return;
    }
    void (async () => {
      const confirmed = await confirmDialog({
        title: t("panels.file.editor.reloadTitle"),
        message: t("panels.file.editor.reloadMessage"),
        confirmLabel: t("panels.file.editor.reload"),
        destructive: true,
      });
      if (confirmed) void model.reload();
    })();
  }, [model, snapshot.modified, t]);
  const handleOverwrite = useCallback(() => void model.overwrite(), [model]);
  const handleRetry = useCallback(() => void model.reload(), [model]);
  const handleReady = useCallback(() => setEditorReady(true), []);
  const editorLocation = useMemo(
    () => ({ path: target.path, lineStart: location.lineStart, lineEnd: location.lineEnd }),
    [location.lineEnd, location.lineStart, target.path],
  );

  if (snapshot.status === "loading") return <FilePanelLoading />;
  if (snapshot.status === "failed") {
    return (
      <View style={styles.centerState}>
        <Text style={styles.errorText}>{snapshot.error ?? t("panels.file.failedToLoad")}</Text>
        <Button variant="outline" size="sm" onPress={handleRetry}>
          {t("common.actions.retry")}
        </Button>
      </View>
    );
  }

  const callout = getFileConflictCallout(snapshot);
  let conflict: FileConflictAlertState | null = null;
  if (callout?.kind === "deleted") conflict = { kind: "deleted" };
  else if (callout) {
    conflict = {
      kind: "changed",
      canOverwrite: callout.canOverwrite,
      onReload: handleReload,
      onOverwrite: handleOverwrite,
    };
  }
  return (
    <View style={styles.container}>
      {conflict ? <FileConflictAlert state={conflict} /> : null}
      <View style={styles.editor}>
        <ThemedFileEditorView
          model={model}
          filename={target.path}
          location={editorLocation}
          navigationRevision={location.revision}
          vimEnabled={settings.vimKeybindings}
          onCursorChange={setCursor}
          onVimModeChange={setVimMode}
          onReady={handleReady}
        />
        {editorReady ? null : <FilePanelLoading />}
      </View>
      <SourceStatusRow
        size={file.size}
        lineCount={snapshot.content.split("\n").length}
        editorStatus={snapshot.status}
        vimMode={vimMode}
        cursor={cursor}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, minHeight: 0 },
  editor: { flex: 1, minHeight: 0 },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[4],
  },
  mutedText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
}));

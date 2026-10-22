import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type ComponentType,
} from "react";
import { useFileText, type PluginFileLocation } from "@getpaseo/plugin/client";
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
import type { FileConflictAlertState } from "./conflict-alert";
import { FileEditorModel, getFileConflictCallout } from "./editor/model";
import { FileEditorView } from "./editor/view";
import { selectSourcePresentation } from "./readonly/presentation";
import { FileSourceView } from "./readonly/view";
import { TextFileToolbar, type TextFileView } from "./toolbar";

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

/** A rendered view of the file's text: the panel's Preview, shown instead of its source. */
export interface TextFilePreviewProps {
  text: string;
  target: BuiltinFilePanelProps["target"];
}

type TextFilePanelProps = BuiltinFilePanelProps & {
  /** The panel's Preview; with one, the toolbar switches between Preview and Source. */
  preview?: ComponentType<TextFilePreviewProps>;
};

/**
 * What the Markdown, HTML and Source panels share: a toolbar over the file's Source view and, when
 * the panel passes one, its Preview. Both views show the one read of the file and, while editing, the one editor buffer, so switching
 * between them neither re-reads nor loses edits. Edits files up to 1 MiB on web; shows larger files
 * and every file on native read-only, and refuses files above the display budget before reading.
 */
export function TextFilePanel(props: TextFilePanelProps) {
  const size = props.file.size;
  const presentation = selectSourcePresentation({ size, platform: isWeb ? "web" : "native" });
  if (presentation === "unsupported") return <TooLargeTextFile size={size} />;
  if (isWeb && size <= MAX_EDITABLE_BYTES) return <EditableTextFile {...props} />;
  return <ReadonlyTextFile {...props} presentation={presentation} />;
}

/**
 * The view a panel with a preview shows. It opens on Preview, and on Source for a line target;
 * each later line target switches to Source again.
 */
function useTextFileView(
  location: PluginFileLocation,
): [TextFileView, (view: TextFileView) => void] {
  const lineTarget = location.lineStart ? location.revision : null;
  const [view, setView] = useState<TextFileView>(lineTarget === null ? "preview" : "source");
  const [shownLineTarget, setShownLineTarget] = useState(lineTarget);
  if (lineTarget !== null && lineTarget !== shownLineTarget) {
    setShownLineTarget(lineTarget);
    setView("source");
  }
  return [view, setView];
}

function TooLargeTextFile({ size }: { size: number }) {
  const { t } = useTranslation();
  return (
    <View style={styles.centerState} testID="file-source-too-large">
      <Text style={styles.mutedText}>{t("panels.file.tooLargeToDisplay")}</Text>
      <Text style={styles.mutedText}>{formatFileSize(size)}</Text>
    </View>
  );
}

function ReadonlyTextFile({
  file,
  location,
  target,
  preview: Preview,
  presentation,
}: TextFilePanelProps & { presentation: "highlighted" | "plain" }) {
  const text = useFileText(file);
  const { t } = useTranslation();
  const [view, setView] = useTextFileView(location);
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
  const showPreview = Preview !== undefined && view === "preview";
  return (
    <View style={styles.container}>
      <TextFileToolbar
        size={file.size}
        lineCount={text.text.split("\n").length}
        view={Preview ? view : undefined}
        onViewChange={Preview ? setView : undefined}
      />
      {showPreview ? (
        <Preview text={text.text} target={target} />
      ) : (
        <ThemedFileSourceView
          content={text.text}
          filename={target.path}
          location={sourceLocation}
          navigationRevision={location.revision}
          presentation={presentation}
        />
      )}
    </View>
  );
}

function EditableTextFile({ file, tab, location, target, preview: Preview }: TextFilePanelProps) {
  const { settings } = useAppSettings();
  const { t } = useTranslation();
  const [model] = useState(() => new FileEditorModel({ file }));
  const [view, setView] = useTextFileView(location);
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
  const showPreview = Preview !== undefined && view === "preview";
  return (
    <View style={styles.container}>
      <TextFileToolbar
        size={file.size}
        lineCount={snapshot.content.split("\n").length}
        view={Preview ? view : undefined}
        onViewChange={Preview ? setView : undefined}
        editorStatus={snapshot.status}
        cursor={showPreview ? undefined : cursor}
        vimMode={showPreview ? null : vimMode}
        conflict={conflict}
      />
      {showPreview ? (
        <Preview text={snapshot.content} target={target} />
      ) : (
        <SourceEditor
          model={model}
          filename={target.path}
          location={editorLocation}
          navigationRevision={location.revision}
          vimEnabled={settings.vimKeybindings}
          onCursorChange={setCursor}
          onVimModeChange={setVimMode}
        />
      )}
    </View>
  );
}

/** The editor over the panel's buffer. Each mount shows Loading until the editor shows the text. */
function SourceEditor(props: Omit<ComponentProps<typeof ThemedFileEditorView>, "onReady">) {
  const [ready, setReady] = useState(false);
  const handleReady = useCallback(() => setReady(true), []);
  return (
    <View style={styles.editor}>
      <ThemedFileEditorView {...props} onReady={handleReady} />
      {ready ? null : <FilePanelLoading />}
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

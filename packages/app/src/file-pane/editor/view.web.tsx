import * as Clipboard from "expo-clipboard";
import { selectAll } from "@codemirror/commands";
import { Shortcut } from "@/components/ui/shortcut";
import { usePaneContext } from "@/panels/pane-context";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import { useToast } from "@/contexts/toast-context";
import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { isTypeScriptFile } from "@getpaseo/protocol/code-language";
import { useLanguageActions } from "@/code-language/use-actions.web";
import { LanguageOverlay } from "@/code-language/overlay.web";
import { editorLanguageExtension, editorCodeTarget } from "@/code-language/editor.web";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { isAbsolutePath } from "@/utils/path";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { Annotation, Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { getLanguageForFile } from "@getpaseo/highlight";
import { getCM, vim } from "@replit/codemirror-vim";
import { isRenderedMarkdownFile } from "@/components/file-pane-render-mode";
import type { WorkspaceFileLocation } from "@/workspace/file-open";
import type { FileEditorModel } from "./model";
import { editorBaseExtensions, editorTheme, type EditorVisualTheme } from "./extensions.web";

interface FileEditorViewProps {
  model: FileEditorModel;
  filename: string;
  location: WorkspaceFileLocation;
  navigationRevision: number;
  vimEnabled: boolean;
  theme: EditorVisualTheme;
  onCursorChange(position: { line: number; column: number }): void;
  onVimModeChange(mode: string | null): void;
}

const intelligenceCompartment = new Compartment();
const languageCompartment = new Compartment();
const wrappingCompartment = new Compartment();
const themeCompartment = new Compartment();
const vimCompartment = new Compartment();

function wrappingForFile(filename: string) {
  return isRenderedMarkdownFile(filename) ? EditorView.lineWrapping : [];
}

export function FileEditorView({
  model,
  filename,
  location,
  navigationRevision,
  vimEnabled,
  theme,
  onCursorChange,
  onVimModeChange,
}: FileEditorViewProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const pane = usePaneContext();
  const fileVersion = model.getSnapshot().version;
  const workspaceDirectory = useWorkspaceDirectory(pane.serverId, pane.workspaceId);
  const actions = useLanguageActions(
    isTypeScriptFile(filename) && workspaceDirectory
      ? {
          serverId: pane.serverId,
          cwd: workspaceDirectory,
          onOpenLocation: (destination) =>
            pane.openFileInWorkspace({ disposition: "preferred", location: destination }),
        }
      : null,
  );
  const path = isAbsolutePath(fileVersion.path)
    ? fileVersion.path
    : `${fileVersion.cwd}/${fileVersion.path}`;
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const initial = useRef({ filename, model, theme, vimEnabled, content: snapshot.content });
  const onCursorChangeRef = useRef(onCursorChange);
  onCursorChangeRef.current = onCursorChange;

  useEffect(() => {
    if (!hostRef.current) return;
    const values = initial.current;
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: values.content,
        extensions: [
          intelligenceCompartment.of([]),
          vimCompartment.of(values.vimEnabled ? vim() : []),
          ...editorBaseExtensions(() => void values.model.save()),
          languageCompartment.of(getLanguageForFile(values.filename)?.extension ?? []),
          wrappingCompartment.of(wrappingForFile(values.filename)),
          themeCompartment.of(editorTheme(values.theme)),
          EditorView.updateListener.of((update) => {
            if (
              update.docChanged &&
              !update.transactions.some((tr) => tr.annotation(remoteUpdate))
            ) {
              const { lineSeparator } = values.model.getSnapshot();
              values.model.edit(update.state.doc.sliceString(0, undefined, lineSeparator));
            }
            if (update.selectionSet || update.docChanged) {
              const head = update.state.selection.main.head;
              const line = update.state.doc.lineAt(head);
              onCursorChangeRef.current({ line: line.number, column: head - line.from + 1 });
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    onCursorChangeRef.current({ line: 1, column: 1 });
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const document = view.state.toText(snapshot.content);
    if (view.state.doc.eq(document)) return;
    const head = Math.min(view.state.selection.main.head, document.length);
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: document },
      selection: { anchor: head },
      annotations: [remoteUpdate.of(true), Transaction.addToHistory.of(false)],
    });
  }, [snapshot.content]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !location.lineStart) return;
    const lineStart = Math.min(location.lineStart, view.state.doc.lines);
    const lineEnd = Math.min(location.lineEnd ?? lineStart, view.state.doc.lines);
    const first = view.state.doc.line(lineStart);
    const last = view.state.doc.line(Math.max(lineStart, lineEnd));
    const from = Math.min(first.to, first.from + (location.columnStart ?? 1) - 1);
    const to = location.columnEnd ? Math.min(last.to, last.from + location.columnEnd - 1) : last.to;
    view.dispatch({
      selection: { anchor: from, head: lineEnd > lineStart || location.columnEnd ? to : from },
      effects: EditorView.scrollIntoView(from, { y: "center" }),
    });
  }, [
    location.lineEnd,
    location.lineStart,
    location.columnStart,
    location.columnEnd,
    navigationRevision,
  ]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: [
        languageCompartment.reconfigure(getLanguageForFile(filename)?.extension ?? []),
        wrappingCompartment.reconfigure(wrappingForFile(filename)),
      ],
    });
  }, [filename]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: themeCompartment.reconfigure(editorTheme(theme)) });
  }, [theme]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: vimCompartment.reconfigure(vimEnabled ? vim() : []) });
    if (!vimEnabled) {
      onVimModeChange(null);
      return;
    }
    const cm = getCM(view);
    if (!cm) return;
    function handleModeChange(event: { mode?: string }) {
      onVimModeChange((event.mode ?? "normal").toUpperCase());
    }
    cm.on("vim-mode-change", handleModeChange);
    onVimModeChange("NORMAL");
    return () => cm.off("vim-mode-change", handleModeChange);
  }, [onVimModeChange, vimEnabled]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: intelligenceCompartment.reconfigure(
        actions ? editorLanguageExtension(actions, path) : [],
      ),
    });
    if (!actions) return;
    const lease = actions.scope.retain(path, model.getSnapshot().content);
    const unsubscribe = model.subscribe(() => lease.update(model.getSnapshot().content));
    return () => {
      unsubscribe();
      lease.release();
      actions.dismiss();
    };
  }, [actions, model, path]);

  const run = useCallback(
    (operation: "hover" | "definition" | "references") => {
      const view = viewRef.current;
      if (view && actions)
        void actions.run(editorCodeTarget(view, path), operation, undefined, () => view.focus());
    },
    [actions, path],
  );
  const inspect = useCallback(() => run("hover"), [run]);
  const inspectShortcut = useMemo(() => <Shortcut keys={INSPECT_SHORTCUT_KEYS} />, []);
  const define = useCallback(() => run("definition"), [run]);
  const usages = useCallback(() => run("references"), [run]);
  const copySelection = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const selection = view.state.selection.main;
    void Clipboard.setStringAsync(view.state.sliceDoc(selection.from, selection.to)).catch(() =>
      toast.error(t("common.errors.unableToCopy")),
    );
  }, [t, toast]);
  const selectDocument = useCallback(() => {
    const view = viewRef.current;
    if (view) {
      selectAll(view);
      view.focus();
    }
  }, []);
  const preserveNativeMenu = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (!actions) event.stopPropagation();
    },
    [actions],
  );
  return (
    <ContextMenu>
      <ContextMenuTrigger contextOnly style={TRIGGER_STYLE}>
        <div
          ref={hostRef}
          data-pmono=""
          onContextMenuCapture={preserveNativeMenu}
          data-testid="file-source-editor"
          aria-label={`Source editor for ${filename}`}
          style={HOST_STYLE}
        />
      </ContextMenuTrigger>
      {actions && (
        <>
          <ContextMenuContent>
            <ContextMenuItem onSelect={copySelection}>{t("common.actions.copy")}</ContextMenuItem>
            <ContextMenuItem onSelect={selectDocument}>
              {t("common.actions.selectAll")}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={inspect} trailing={inspectShortcut}>
              {t("codeLanguage.inspect")}
            </ContextMenuItem>
            <ContextMenuItem onSelect={define}>{t("codeLanguage.definition")}</ContextMenuItem>
            <ContextMenuItem onSelect={usages}>{t("codeLanguage.usages")}</ContextMenuItem>
          </ContextMenuContent>
          <LanguageOverlay actions={actions} />
        </>
      )}
    </ContextMenu>
  );
}

const INSPECT_SHORTCUT_KEYS = ["alt", "F12"];

const remoteUpdate = Annotation.define<boolean>();
const HOST_STYLE = { flex: 1, minHeight: 0, overflow: "hidden" } as const;

const TRIGGER_STYLE = { flex: 1, minHeight: 0 };

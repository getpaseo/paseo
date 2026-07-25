import { useEffect, useRef, useSyncExternalStore } from "react";
import { Annotation, Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { getLanguageForFile } from "@getpaseo/highlight";
import { getCM, vim } from "@replit/codemirror-vim";
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

const languageCompartment = new Compartment();
const themeCompartment = new Compartment();
const vimCompartment = new Compartment();

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
          vimCompartment.of(values.vimEnabled ? vim() : []),
          ...editorBaseExtensions(() => void values.model.save()),
          languageCompartment.of(getLanguageForFile(values.filename)?.extension ?? []),
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
    const from = view.state.doc.line(lineStart).from;
    const to = view.state.doc.line(Math.max(lineStart, lineEnd)).to;
    view.dispatch({
      selection: { anchor: from, head: lineEnd > lineStart ? to : from },
      effects: EditorView.scrollIntoView(from, { y: "center" }),
    });
  }, [location.lineEnd, location.lineStart, navigationRevision]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: languageCompartment.reconfigure(getLanguageForFile(filename)?.extension ?? []),
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

  return (
    <div
      ref={hostRef}
      data-pmono=""
      data-testid="file-source-editor"
      aria-label={`Source editor for ${filename}`}
      style={HOST_STYLE}
    />
  );
}

const remoteUpdate = Annotation.define<boolean>();
const HOST_STYLE = { flex: 1, minHeight: 0, overflow: "hidden" } as const;

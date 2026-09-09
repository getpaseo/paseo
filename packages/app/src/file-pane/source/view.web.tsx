import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
import { FileFind, FileFindModel } from "../find/index.web";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, drawSelection } from "@codemirror/view";
import { getLanguageForFile } from "@getpaseo/highlight";
import { resolveWorkspaceFileSelection, type WorkspaceFileLocation } from "@/workspace/file-open";
import type { EditorVisualTheme } from "../editor/extensions.web";
import { editorTheme } from "../editor/extensions.web";
import { selectSourcePresentation, type SourcePresentation } from "./presentation";

interface FileSourceViewProps {
  content: string;
  filename: string;
  location: WorkspaceFileLocation;
  navigationRevision: number;
  size: number;
  theme: EditorVisualTheme;
  tooLargeMessage: string;
}

const languageCompartment = new Compartment();
const themeCompartment = new Compartment();

export function FileSourceView({
  content,
  filename,
  location,
  navigationRevision,
  size,
  theme,
  tooLargeMessage,
}: FileSourceViewProps) {
  const presentation = selectSourcePresentation({ size, platform: "web" });
  if (presentation === "unsupported") {
    return (
      <div data-testid="file-source-too-large" style={UNSUPPORTED_STYLE}>
        {tooLargeMessage}
      </div>
    );
  }
  return (
    <ReadonlyCodeMirror
      content={content}
      filename={filename}
      location={location}
      navigationRevision={navigationRevision}
      presentation={presentation}
      theme={theme}
    />
  );
}

function ReadonlyCodeMirror({
  content,
  filename,
  location,
  navigationRevision,
  presentation,
  theme,
}: Omit<FileSourceViewProps, "size" | "tooLargeMessage"> & {
  presentation: Exclude<SourcePresentation, "unsupported">;
}) {
  const { t } = useTranslation();
  const [find] = useState(() => new FileFindModel());
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const initial = useRef({ content, filename, presentation, theme });

  useEffect(() => {
    if (!hostRef.current) return;
    const values = initial.current;
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: values.content,
        extensions: [
          find.extension,
          EditorState.readOnly.of(true),
          EditorView.contentAttributes.of({
            tabindex: "0",
            "aria-label": `Source for ${values.filename}`,
          }),
          // The preview is never focused, so the browser draws no selection of its own; the
          // exact occurrence has to be painted by CodeMirror.
          drawSelection(),
          EditorView.editable.of(false),
          languageCompartment.of(
            languageFor({ filename: values.filename, presentation: values.presentation }),
          ),
          themeCompartment.of(editorTheme(values.theme)),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [find]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === content) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
  }, [content]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: [
        languageCompartment.reconfigure(languageFor({ filename, presentation })),
        themeCompartment.reconfigure(editorTheme(theme)),
      ],
    });
  }, [filename, presentation, theme]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !location.lineStart) return;
    const { from, to } = resolveWorkspaceFileSelection(view.state.doc.toString(), location);
    view.dispatch({
      selection: { anchor: from, head: to },
      effects: EditorView.scrollIntoView(from, { y: "center" }),
    });
  }, [content, location, navigationRevision]);

  const changed = resolveWorkspaceFileSelection(content.replace(/\r\n?/g, "\n"), location).changed;
  return (
    <div style={FRAME_STYLE}>
      {changed ? <div role="status">{t("shell.commandCenter.contentChanged")}</div> : null}
      <div ref={hostRef} data-testid="file-source-editor" style={HOST_STYLE} />
      <FileFind model={find} editor={viewRef} />
    </div>
  );
}

function languageFor(input: {
  filename: string;
  presentation: Exclude<SourcePresentation, "unsupported">;
}) {
  return input.presentation === "highlighted"
    ? (getLanguageForFile(input.filename)?.extension ?? [])
    : [];
}

// The Find widget floats inside this frame, so it stays relative; the change notice is the
// only row that shares the column with the editor host.
const FRAME_STYLE = {
  display: "flex",
  flexDirection: "column",
  position: "relative",
  flex: 1,
  minHeight: 0,
  minWidth: 0,
} as const;
const HOST_STYLE = { flex: 1, minHeight: 0, overflow: "hidden" } as const;
const UNSUPPORTED_STYLE = {
  alignItems: "center",
  display: "flex",
  flex: 1,
  justifyContent: "center",
} as const;

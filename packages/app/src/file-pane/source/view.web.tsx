import { useEffect, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { getLanguageForFile } from "@getpaseo/highlight";
import type { WorkspaceFileLocation } from "@/workspace/file-open";
import type { EditorVisualTheme } from "../editor/extensions.web";
import { editorTheme } from "../editor/extensions.web";
import { selectSourcePresentation, type SourcePresentation } from "./presentation";
import type { GoToDefinitionCallbacks } from "./go-to-definition";
import { goToDefinition } from "./go-to-definition.web";

interface FileSourceViewProps {
  content: string;
  filename: string;
  location: WorkspaceFileLocation;
  navigationRevision: number;
  size: number;
  theme: EditorVisualTheme;
  tooLargeMessage: string;
  /** Absent when the host cannot resolve definitions; the affordance stays off entirely. */
  definitions?: GoToDefinitionCallbacks | null;
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
  definitions,
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
      definitions={definitions}
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
  definitions,
}: Omit<FileSourceViewProps, "size" | "tooLargeMessage"> & {
  presentation: Exclude<SourcePresentation, "unsupported">;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const initial = useRef({ content, filename, presentation, theme });
  // The extension is installed once; this ref keeps it calling the current callbacks.
  const definitionsRef = useRef(definitions);
  definitionsRef.current = definitions;

  useEffect(() => {
    if (!hostRef.current) return;
    const values = initial.current;
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: values.content,
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          languageCompartment.of(
            languageFor({ filename: values.filename, presentation: values.presentation }),
          ),
          themeCompartment.of(editorTheme(values.theme)),
          goToDefinition({
            resolve: (position) =>
              definitionsRef.current?.resolve(position) ?? Promise.resolve(null),
            navigate: (target) => definitionsRef.current?.navigate(target),
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

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
    const line = Math.min(location.lineStart, view.state.doc.lines);
    const from = view.state.doc.line(line).from;
    view.dispatch({ effects: EditorView.scrollIntoView(from, { y: "center" }) });
  }, [location.lineStart, navigationRevision]);

  return <div ref={hostRef} data-testid="file-source-editor" style={HOST_STYLE} />;
}

function languageFor(input: {
  filename: string;
  presentation: Exclude<SourcePresentation, "unsupported">;
}) {
  return input.presentation === "highlighted"
    ? (getLanguageForFile(input.filename)?.extension ?? [])
    : [];
}

const HOST_STYLE = { flex: 1, minHeight: 0, overflow: "hidden" } as const;
const UNSUPPORTED_STYLE = {
  alignItems: "center",
  display: "flex",
  flex: 1,
  justifyContent: "center",
} as const;

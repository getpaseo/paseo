import { useEffect, useMemo, useRef, useState } from "react";
import { SourceEditorController } from "./controller";
import type { SourceEditorConfiguration, SourceEditorProps } from "./contract";
import { CodeMirrorRuntime } from "./codemirror/runtime";

let nextEditorKey = 1;

export function SourceEditor(props: SourceEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<CodeMirrorRuntime | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const initial = useRef(props);
  const [editorKey] = useState(() => `web-source-editor-${nextEditorKey++}`);
  const controllerRef = useRef<SourceEditorController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = new SourceEditorController({
      editorKey,
      document: initial.current.document,
      callbacks: {
        onChange: (document) => propsRef.current.onChange(document),
        onSave: () => propsRef.current.onSave(),
        onCursorChange: (position) => propsRef.current.onCursorChange(position),
        onVimModeChange: (mode) => propsRef.current.onVimModeChange(mode),
      },
    });
  }
  const controller = controllerRef.current;
  const configuration = useMemo<SourceEditorConfiguration>(
    () => ({ filename: props.filename, vimEnabled: props.vimEnabled, theme: props.theme }),
    [props.filename, props.theme, props.vimEnabled],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const runtime = new CodeMirrorRuntime();
    runtimeRef.current = runtime;
    runtime.mount({
      host,
      document: controller.getRuntimeDocument(),
      configuration: configurationFromProps(initial.current),
      callbacks: {
        onChange: (changes) => controller.receive({ type: "change", editorKey, changes }),
        onSave: () => controller.receive({ type: "save", editorKey }),
        onCursorChange: (position) =>
          controller.receive({ type: "cursor", editorKey, ...position }),
        onVimModeChange: (mode) => controller.receive({ type: "vimMode", editorKey, mode }),
      },
    });
    return () => {
      runtime.destroy();
      runtimeRef.current = null;
    };
  }, [controller, editorKey]);

  useEffect(() => {
    const replacement = controller.replaceDocument(props.document);
    if (replacement !== null) runtimeRef.current?.replaceDocument(replacement);
  }, [controller, props.document]);

  useEffect(() => {
    runtimeRef.current?.configure(configuration);
  }, [configuration]);

  useEffect(() => {
    if (props.selectionTarget) runtimeRef.current?.reveal(props.selectionTarget);
  }, [props.selectionTarget]);

  return (
    <div
      ref={hostRef}
      data-pmono=""
      data-testid="file-source-editor"
      aria-label={`Source editor for ${props.filename}`}
      style={HOST_STYLE}
    />
  );
}

function configurationFromProps(props: SourceEditorProps): SourceEditorConfiguration {
  return { filename: props.filename, vimEnabled: props.vimEnabled, theme: props.theme };
}

const HOST_STYLE = { flex: 1, minHeight: 0, overflow: "hidden" } as const;

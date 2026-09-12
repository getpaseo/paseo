import { useCallback, useMemo, useSyncExternalStore } from "react";
import { SourceEditor } from "@/source-editor/source-editor";
import type { SourceEditorTheme } from "@/source-editor/contract";
import type { WorkspaceFileLocation } from "@/workspace/file-open";
import type { FileEditorModel } from "./model";

export function FileEditorView(props: {
  model: FileEditorModel;
  filename: string;
  location: WorkspaceFileLocation;
  navigationRevision: number;
  vimEnabled: boolean;
  theme: SourceEditorTheme;
  onCursorChange(position: { line: number; column: number }): void;
  onVimModeChange(mode: string | null): void;
}) {
  const snapshot = useSyncExternalStore(
    props.model.subscribe,
    props.model.getSnapshot,
    props.model.getSnapshot,
  );
  const selectionTarget = useMemo(
    () =>
      props.location.lineStart
        ? {
            lineStart: props.location.lineStart,
            lineEnd: props.location.lineEnd,
            revision: props.navigationRevision,
          }
        : undefined,
    [props.location.lineEnd, props.location.lineStart, props.navigationRevision],
  );
  const handleChange = useCallback((document: string) => props.model.edit(document), [props.model]);
  const handleSave = useCallback(() => void props.model.save(), [props.model]);

  return (
    <SourceEditor
      document={snapshot.content}
      filename={props.filename}
      selectionTarget={selectionTarget}
      vimEnabled={props.vimEnabled}
      theme={props.theme}
      onChange={handleChange}
      onSave={handleSave}
      onCursorChange={props.onCursorChange}
      onVimModeChange={props.onVimModeChange}
    />
  );
}

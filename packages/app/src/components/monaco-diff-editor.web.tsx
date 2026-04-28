import { useCallback, useEffect, useRef, useState } from "react";
import { DiffEditor, type DiffOnMount } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { useMonacoSelectionSync } from "@/hooks/sharing/use-monaco-selection-sync";

export interface MonacoDiffEditorProps {
  originalValue: string;
  modifiedValue: string;
  filePath: string;
  isDark: boolean;
  renderSideBySide?: boolean;
}

const LANGUAGE_MAP: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  json: "json",
  md: "markdown",
  css: "css",
  scss: "scss",
  html: "html",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  php: "php",
  sh: "shell",
  bash: "shell",
  sql: "sql",
  swift: "swift",
  kt: "kotlin",
  c: "c",
  cpp: "cpp",
  h: "c",
  hpp: "cpp",
  toml: "ini",
  env: "ini",
};

export function MonacoDiffEditor({
  originalValue,
  modifiedValue,
  filePath,
  isDark,
  renderSideBySide = true,
}: MonacoDiffEditorProps) {
  const editorRef = useRef<editor.IStandaloneDiffEditor | null>(null);
  const [mountTick, setMountTick] = useState(0);

  const handleMount: DiffOnMount = useCallback((diffEditor) => {
    editorRef.current = diffEditor;
    // Re-run the selection-sync hook now that the editor instance exists.
    setMountTick((n) => n + 1);
  }, []);

  const getEditors = useCallback(() => {
    const diff = editorRef.current;
    if (!diff) return [null, null];
    try {
      return [diff.getOriginalEditor(), diff.getModifiedEditor()];
    } catch {
      return [null, null];
    }
    // mountTick keeps the callback identity stable between mount events so the
    // effect in useMonacoSelectionSync re-runs after the editor is ready.
    void mountTick;
  }, [mountTick]);
  useMonacoSelectionSync(getEditors);

  // Dispose editor manually on unmount to avoid the "TextModel got disposed" race
  useEffect(() => {
    return () => {
      if (editorRef.current) {
        try {
          editorRef.current.dispose();
        } catch {
          // Already disposed, ignore
        }
        editorRef.current = null;
      }
    };
  }, []);

  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const language = LANGUAGE_MAP[ext] ?? undefined;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, height: "100%" }}>
      <DiffEditor
        original={originalValue}
        modified={modifiedValue}
        language={language}
        theme={isDark ? "vs-dark" : "vs"}
        onMount={handleMount}
        keepCurrentOriginalModel
        keepCurrentModifiedModel
        options={{
          minimap: { enabled: false },
          fontSize: 13,
          lineHeight: 19,
          scrollBeyondLastLine: false,
          automaticLayout: true,
          wordWrap: "off",
          renderWhitespace: "none",
          padding: { top: 8, bottom: 8 },
          readOnly: true,
          renderSideBySide,
          enableSplitViewResizing: true,
          renderOverviewRuler: false,
          diffWordWrap: "off",
          ignoreTrimWhitespace: true,
        }}
      />
    </div>
  );
}

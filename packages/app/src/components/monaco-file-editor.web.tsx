import { useCallback, useEffect, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";

export interface MonacoFileEditorProps {
  value: string;
  filePath: string;
  isDark: boolean;
  onSave: (content: string) => void;
  onDirtyChange?: (isDirty: boolean) => void;
}

export function MonacoFileEditor({
  value,
  filePath,
  isDark,
  onSave,
  onDirtyChange,
}: MonacoFileEditorProps) {
  const [content, setContent] = useState(value);
  const contentRef = useRef(content);
  const onSaveRef = useRef(onSave);
  const onDirtyChangeRef = useRef(onDirtyChange);

  useEffect(() => {
    onSaveRef.current = onSave;
  });

  useEffect(() => {
    onDirtyChangeRef.current = onDirtyChange;
  });

  useEffect(() => {
    setContent(value);
    contentRef.current = value;
  }, [value, filePath]);

  const handleChange = useCallback((val: string | undefined) => {
    const updated = val ?? "";
    setContent(updated);
    contentRef.current = updated;
    onDirtyChangeRef.current?.(true);
  }, []);

  const handleMount: OnMount = useCallback((editor, monaco) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      onSaveRef.current(contentRef.current);
      // dirty clears in onSuccess of the write mutation, not here
    });
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, height: "100%" }}>
      <Editor
        value={content}
        path={filePath}
        theme={isDark ? "vs-dark" : "vs"}
        onChange={handleChange}
        onMount={handleMount}
        options={{
          minimap: { enabled: false },
          fontSize: 13,
          lineHeight: 19,
          scrollBeyondLastLine: false,
          automaticLayout: true,
          wordWrap: "off",
          renderWhitespace: "none",
          padding: { top: 12, bottom: 12 },
        }}
      />
    </div>
  );
}

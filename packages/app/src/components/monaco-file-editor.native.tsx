export interface MonacoFileEditorProps {
  value: string;
  filePath: string;
  isDark: boolean;
  onSave: (content: string) => void;
  onDirtyChange?: (isDirty: boolean) => void;
}

export function MonacoFileEditor(_props: MonacoFileEditorProps) {
  return null;
}

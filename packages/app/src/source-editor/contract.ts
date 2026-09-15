import type { HighlightStyle } from "@getpaseo/highlight";

export interface SourceChange {
  from: number;
  to: number;
  insert: string;
}

export interface SourceEditorPosition {
  line: number;
  column: number;
}

export interface SourceEditorSelectionTarget {
  lineStart: number;
  lineEnd?: number;
  revision: number;
}

export interface SourceEditorTheme {
  colorScheme: "light" | "dark";
  background: string;
  foreground: string;
  cursor: string;
  foregroundMuted: string;
  border: string;
  selection: string;
  monoFont: string;
  codeFontSize: number;
  syntax: Record<HighlightStyle, string>;
}

export interface SourceEditorConfiguration {
  filename: string;
  vimEnabled: boolean;
  theme: SourceEditorTheme;
}

export interface SourceEditorProps extends SourceEditorConfiguration {
  document: string;
  selectionTarget?: SourceEditorSelectionTarget;
  onChange(document: string): void;
  onSave(): void;
  onCursorChange(position: SourceEditorPosition): void;
  onVimModeChange(mode: string | null): void;
}

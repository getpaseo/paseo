import type { DaemonClient, FileReadMetadata } from "@getpaseo/client/internal/daemon-client";

export type FileOpenMode = "smart" | "preview" | "external" | "ask";
export interface FileOpenRule {
  mode: FileOpenMode;
  application?: string;
}
export interface FileOpeningPreferences {
  mode: FileOpenMode;
  byExtension: Record<string, FileOpenRule>;
}
export interface FileAccessTarget {
  serverId: string;
  cwd: string;
  path: string;
}
export interface MaterializedFile extends FileReadMetadata {
  uri: string;
  name: string;
  offline?: boolean;
  release(): void;
}
export interface MaterializeInput {
  client: DaemonClient | null;
  target: FileAccessTarget;
  maxBytes?: number;
  signal?: AbortSignal;
  onProgress?(received: number, total: number): void;
}
export function fileExtension(path: string): string {
  const name = path.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}
export function resolveFileOpenRule(
  path: string,
  preferences: FileOpeningPreferences,
): FileOpenRule {
  return preferences.byExtension[fileExtension(path)] ?? { mode: preferences.mode };
}
export function documentKind(path: string): "pdf" | "word" | null {
  const extension = fileExtension(path);
  if (extension === "pdf") return "pdf";
  if (extension === "doc" || extension === "docx") return "word";
  return null;
}

export function resolveFileOpenMode(path: string, mode: FileOpenMode): FileOpenMode {
  if (mode === "smart") return canPreviewFile(path) ? "preview" : "external";
  if (mode === "preview" && !canPreviewFile(path)) return "external";
  return mode;
}

export function canPreviewFile(path: string): boolean {
  return /^(pdf|doc|docx|md|mdx|txt|csv|json|jsonl|yaml|yml|xml|html|htm|css|js|jsx|ts|tsx|py|go|rs|java|kt|swift|c|h|cpp|sh|toml|log|sql|png|jpg|jpeg|gif|webp|svg)$/i.test(
    fileExtension(path),
  );
}

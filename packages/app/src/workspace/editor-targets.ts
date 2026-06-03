export type EditorTargetId = string;
export type KnownEditorTargetId =
  | "cursor"
  | "vscode"
  | "webstorm"
  | "zed"
  | "finder"
  | "explorer"
  | "file-manager";

const KNOWN_EDITOR_TARGET_IDS: ReadonlySet<string> = new Set([
  "cursor",
  "vscode",
  "webstorm",
  "zed",
  "finder",
  "explorer",
  "file-manager",
]);

export function isKnownEditorTargetId(editorId: EditorTargetId): editorId is KnownEditorTargetId {
  return KNOWN_EDITOR_TARGET_IDS.has(editorId);
}

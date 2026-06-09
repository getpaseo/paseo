export type EditorTargetId = string;

const KNOWN_EDITOR_TARGET_IDS: ReadonlySet<string> = new Set([
  "cursor",
  "vscode",
  "webstorm",
  "zed",
  "antigravity",
  "finder",
  "explorer",
  "file-manager",
]);

export function isKnownEditorTargetId(editorId: EditorTargetId): boolean {
  return KNOWN_EDITOR_TARGET_IDS.has(editorId);
}

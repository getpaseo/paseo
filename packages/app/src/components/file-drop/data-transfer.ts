import { WORKSPACE_FILE_DRAG_MIME } from "@/attachments/workspace-file-drag";

export interface DragSinkCapabilities {
  acceptsWorkspaceFile: boolean;
  acceptsText: boolean;
}

export interface DragClassification {
  isAccepted: boolean;
  isTextDrag: boolean;
}

const TEXT_DRAG_TYPES = ["text/plain", "text/uri-list"];

export function classifyDragTypes(
  types: readonly string[],
  capabilities: DragSinkCapabilities,
): DragClassification {
  const present = new Set(types);
  const hasFiles = present.has("Files");
  const hasWorkspaceFile = present.has(WORKSPACE_FILE_DRAG_MIME);
  const hasText = TEXT_DRAG_TYPES.some((type) => present.has(type));
  const isAccepted =
    hasFiles ||
    (hasWorkspaceFile && capabilities.acceptsWorkspaceFile) ||
    (hasText && capabilities.acceptsText);
  return { isAccepted, isTextDrag: hasText && !hasFiles && !hasWorkspaceFile };
}

export interface DroppedTextSource {
  getData: (type: string) => string;
}

export function readDroppedText(source: DroppedTextSource): string | null {
  const text = source.getData("text/plain") || firstUri(source.getData("text/uri-list"));
  // Drag sources append a trailing newline to selections and links; inner whitespace is payload.
  const withoutTrailingNewline = text.replace(/\r?\n$/, "");
  return withoutTrailingNewline.length > 0 ? withoutTrailingNewline : null;
}

// RFC 2483 text/uri-list: one URI per line, with `#` lines as comments.
function firstUri(uriList: string): string {
  for (const line of uriList.split(/\r?\n/)) {
    const uri = line.trim();
    if (uri.length > 0 && !uri.startsWith("#")) {
      return uri;
    }
  }
  return "";
}

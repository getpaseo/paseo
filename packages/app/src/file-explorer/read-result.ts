import type { FileReadResult } from "@getpaseo/client/internal/daemon-client";
import type { ExplorerFile } from "@/stores/session-store";

export function explorerFileFromReadResult(file: FileReadResult): ExplorerFile {
  const isText = file.kind === "text";
  return {
    path: file.path,
    kind: file.kind,
    encoding: isText ? "utf-8" : "none",
    content: isText ? new TextDecoder().decode(file.bytes) : undefined,
    hasBom: isText && hasUtf8Bom(file.bytes),
    mimeType: file.mime,
    size: file.size,
    modifiedAt: file.modifiedAt,
  };
}

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

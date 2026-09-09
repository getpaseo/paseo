import type { FileReadResult } from "@getpaseo/client/internal/daemon-client";
import type { ExplorerFile } from "@/stores/session-store";

export function explorerFileFromReadResult(file: FileReadResult): ExplorerFile {
  // SVG keeps its normal image presentation while exposing its UTF-8 source to line targets.
  const isText = file.kind === "text" || file.mime === "image/svg+xml";
  let content: string | undefined;
  if (isText) {
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
    } catch (error) {
      if (file.kind === "text") throw error;
    }
  }
  return {
    path: file.path,
    kind: file.kind,
    encoding: isText ? "utf-8" : "none",
    content,
    hasBom: isText && hasUtf8Bom(file.bytes),
    mimeType: file.mime,
    size: file.size,
    modifiedAt: file.modifiedAt,
    revision: file.revision,
  };
}

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

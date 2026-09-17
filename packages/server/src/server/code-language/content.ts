import { createHash } from "node:crypto";

// Match the text coordinate space used by CodeMirror and LSP (without a BOM).
export function languageText(content: string): string {
  return content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}
export function contentIdentity(content: string): string {
  return createHash("sha256").update(languageText(content)).digest("hex");
}

// CodeMirror normalizes line endings to LF as content enters its editor state. Keep the
// editor's buffer in that representation, then restore the file's dominant ending on write.
export type FileEol = "\n" | "\r\n";

export function detectFileEol(content: string): FileEol {
  let crlf = 0;
  let lf = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) !== 10) continue;
    if (index > 0 && content.charCodeAt(index - 1) === 13) {
      crlf += 1;
    } else {
      lf += 1;
    }
  }
  return crlf > lf ? "\r\n" : "\n";
}

export function normalizeToLf(content: string): string {
  return content.replace(/\r\n?/g, "\n");
}

export function applyFileEol(content: string, eol: FileEol): string {
  return eol === "\r\n" ? content.replace(/\n/g, "\r\n") : content;
}

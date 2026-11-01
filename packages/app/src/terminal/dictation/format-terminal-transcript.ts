/**
 * Turns a dictation transcript into terminal input: embedded line breaks become
 * spaces (a newline would submit the line in most TUIs), the ends are trimmed, and
 * one trailing space separates it from whatever is typed next. Never adds Enter.
 * Returns null when nothing is left to paste.
 */
export function formatTerminalTranscript(text: string): string | null {
  const singleLine = text.replace(/\r\n|\r|\n/g, " ").trim();
  return singleLine.length > 0 ? `${singleLine} ` : null;
}

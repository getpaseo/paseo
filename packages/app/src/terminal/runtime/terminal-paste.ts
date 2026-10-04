export interface TerminalPasteInput {
  text: string;
  bracketedPaste: boolean;
}

export interface TerminalClipboardReader {
  readText: () => Promise<string>;
}

export interface TerminalPaster {
  paste: (text: string) => void;
}

export type TerminalImagePasteMimeType = "image/png" | "image/jpeg";

export interface TerminalImagePasteInput {
  data: string;
  mimeType: TerminalImagePasteMimeType;
}

/**
 * Result of handing clipboard image bytes to the host:
 * - "written": the daemon stored the image on the host clipboard.
 * - "unsupported": the daemon predates image support; the keystroke alone still works.
 * - "error": the hand-off failed; forwarding the keystroke would paste stale content.
 * - "injected": the caller already injected the content as terminal input; no
 *   keystroke must follow or the pasted text would be doubled.
 */
export type TerminalImagePasteOutcome = "written" | "unsupported" | "error" | "injected";

export interface PasteTerminalClipboardInput {
  clipboard: TerminalClipboardReader;
  terminal: TerminalPaster;
}

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
/**
 * The raw Ctrl+V control byte. Codex and OpenCode bind this key and read the OS
 * clipboard themselves to pick up images; no image data ever travels through
 * the pty, so forwarding the keystroke is the only way their handlers fire.
 */
export const TERMINAL_IMAGE_PASTE_KEYSTROKE = "\x16";

export function encodeTerminalPaste(input: TerminalPasteInput): string {
  if (!input.bracketedPaste) {
    return input.text;
  }

  const payload = input.text.replaceAll(BRACKETED_PASTE_END, "[201~");
  return `${BRACKETED_PASTE_START}${payload}${BRACKETED_PASTE_END}`;
}

/**
 * Pastes clipboard text when present. Returns whether anything was pasted so
 * callers can fall back to the image-only path.
 */
export async function pasteTerminalClipboard(input: PasteTerminalClipboardInput): Promise<boolean> {
  const text = await input.clipboard.readText();
  if (text.length === 0) {
    return false;
  }

  input.terminal.paste(text);
  return true;
}

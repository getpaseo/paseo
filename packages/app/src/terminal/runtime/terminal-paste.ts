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

export interface PasteTerminalClipboardInput {
  clipboard: TerminalClipboardReader;
  terminal: TerminalPaster;
}

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

export function encodeTerminalPaste(input: TerminalPasteInput): string {
  if (!input.bracketedPaste) {
    return input.text;
  }

  const payload = input.text.replaceAll(BRACKETED_PASTE_END, "[201~");
  return `${BRACKETED_PASTE_START}${payload}${BRACKETED_PASTE_END}`;
}

export async function pasteTerminalClipboard(input: PasteTerminalClipboardInput): Promise<void> {
  const text = await input.clipboard.readText();
  if (text.length === 0) {
    return;
  }

  input.terminal.paste(text);
}

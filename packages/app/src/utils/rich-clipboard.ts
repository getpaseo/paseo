import { createAssistantMarkdownParser } from "./assistant-markdown-parser";

const markdownRenderer = createAssistantMarkdownParser();
// Disable linkify for selection HTML so text from unwrapped links stays unlinked.
const unlinkedMarkdownRenderer = createAssistantMarkdownParser().set({ linkify: false });

type ClipboardMimeType = "text/plain" | "text/html";

export interface MarkdownClipboardContent {
  plainText: string;
  html: string;
}

export interface RichClipboardWriter {
  supportsHtml: () => boolean;
  write: (data: Record<ClipboardMimeType, Blob>) => Promise<void>;
}

export interface MarkdownClipboardEnvironment {
  richWriter?: RichClipboardWriter | null;
  writePlainText: (text: string) => Promise<unknown>;
}

export function createMarkdownClipboardContent(markdown: string): MarkdownClipboardContent {
  return {
    plainText: markdown,
    html: `<meta charset="utf-8">${markdownRenderer.render(markdown)}`,
  };
}

/**
 * Clipboard payload for Markdown text. `markdown` is escaped and feeds `text/html`, which
 * renders it; `plainText` goes to `text/plain` unchanged, so callers that escape for the
 * rich flavor can hand over the same text the user saw.
 */
export function createSelectionClipboardContent(
  markdown: string,
  plainText: string,
): MarkdownClipboardContent {
  return {
    plainText,
    html: `<meta charset="utf-8">${unlinkedMarkdownRenderer.render(markdown)}`,
  };
}

export interface CodeClipboardOptions {
  language?: string | null;
  /** Wrap in `pre`/`code` so the line structure survives. */
  block: boolean;
}

/**
 * Clipboard payload for a selection that lies inside rendered code.
 *
 * `plainText` is the code exactly as it was selected, so it pastes straight into a
 * shell or an editor.
 *
 * The html half stays undecorated for a single line, matching the rule that a partial
 * selection does not carry its container's formatting. Multi-line code is the
 * exception and needs `pre`: HTML collapses newlines, so anything else loses the line
 * structure in a rich target exactly the way the plain half would.
 *
 * The fence info string is agent-authored, so the language is escaped as an attribute
 * value rather than interpolated raw.
 */
export function createCodeClipboardContent(
  code: string,
  options: CodeClipboardOptions,
): MarkdownClipboardContent {
  const escapedCode = markdownRenderer.utils.escapeHtml(code);
  if (!options.block) {
    return { plainText: code, html: `<meta charset="utf-8">${escapedCode}` };
  }

  const language = options.language?.trim();
  const className = language
    ? ` class="language-${markdownRenderer.utils.escapeHtml(language)}"`
    : "";
  return {
    plainText: code,
    html: `<meta charset="utf-8"><pre><code${className}>${escapedCode}</code></pre>`,
  };
}

export async function writeMarkdownToRichClipboard(
  markdown: string,
  environment: MarkdownClipboardEnvironment,
): Promise<void> {
  await writeClipboardContent(createMarkdownClipboardContent(markdown), environment);
}

/**
 * Writes both flavors, or `plainText` alone where the host has no rich clipboard.
 * Resolves false when the host refused the write.
 */
export async function writeClipboardContent(
  content: MarkdownClipboardContent,
  environment: MarkdownClipboardEnvironment,
): Promise<boolean> {
  if (environment.richWriter?.supportsHtml()) {
    try {
      await environment.richWriter.write({
        "text/plain": new Blob([content.plainText], { type: "text/plain" }),
        "text/html": new Blob([content.html], { type: "text/html" }),
      });
      return true;
    } catch {
      // Fall through to the plain-text path. Some webviews expose rich clipboard
      // APIs but deny writes depending on focus, permissions, or browser policy.
    }
  }

  // Expo resolves false for a write the host refused, instead of rejecting.
  return (await environment.writePlainText(content.plainText)) !== false;
}

import * as Clipboard from "expo-clipboard";
import MarkdownIt from "markdown-it";
import { isWeb } from "@/constants/platform";

const markdownRenderer = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
});

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

export async function writeMarkdownToRichClipboard(
  markdown: string,
  environment: MarkdownClipboardEnvironment = getDefaultMarkdownClipboardEnvironment(),
): Promise<void> {
  if (environment.richWriter?.supportsHtml()) {
    const content = createMarkdownClipboardContent(markdown);
    try {
      await environment.richWriter.write({
        "text/plain": new Blob([content.plainText], { type: "text/plain" }),
        "text/html": new Blob([content.html], { type: "text/html" }),
      });
      return;
    } catch {
      // Fall through to the plain-text path. Some webviews expose rich clipboard
      // APIs but deny writes depending on focus, permissions, or browser policy.
    }
  }

  await environment.writePlainText(markdown);
}

function getDefaultMarkdownClipboardEnvironment(): MarkdownClipboardEnvironment {
  return {
    richWriter: getWebRichClipboardWriter(),
    writePlainText: (text) => Clipboard.setStringAsync(text),
  };
}

function getWebRichClipboardWriter(): RichClipboardWriter | null {
  if (!isWeb) {
    return null;
  }
  if (typeof navigator === "undefined" || typeof navigator.clipboard?.write !== "function") {
    return null;
  }
  if (typeof ClipboardItem === "undefined") {
    return null;
  }

  return {
    supportsHtml: () =>
      typeof ClipboardItem.supports !== "function" || ClipboardItem.supports("text/html"),
    write: async (data) => {
      await navigator.clipboard.write([new ClipboardItem(data)]);
    },
  };
}

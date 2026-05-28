import * as Clipboard from "expo-clipboard";
import { isWeb } from "@/constants/platform";
import type { MarkdownClipboardEnvironment, RichClipboardWriter } from "@/utils/rich-clipboard";

export function getDefaultMarkdownClipboardEnvironment(): MarkdownClipboardEnvironment {
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

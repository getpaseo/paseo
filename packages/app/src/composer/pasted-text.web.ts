import TurndownService from "turndown";

const markdown = new TurndownService({ codeBlockStyle: "fenced", bulletListMarker: "-" });

/** Preserve destinations that the clipboard's plain-text representation cannot carry. */
export function readLinkedClipboardText(
  clipboard: Pick<DataTransfer, "getData"> | null,
): string | null {
  const html = clipboard?.getData("text/html");
  if (!html) return null;

  // Parse in a detached document. Clipboard markup is never mounted in the app.
  const document = new DOMParser().parseFromString(html, "text/html");
  if (!document.querySelector("a[href]")) return null;
  return markdown.turndown(document.body);
}

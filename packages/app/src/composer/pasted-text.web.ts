import TurndownService from "turndown";

const markdown = new TurndownService({ codeBlockStyle: "fenced", bulletListMarker: "-" });

/** Paste linked HTML as Markdown through the browser's undoable editing command. */
export function pasteLinkedClipboardText(
  input: HTMLElement,
  clipboard: Pick<DataTransfer, "getData"> | null,
): boolean {
  const html = clipboard?.getData("text/html");
  if (!html) return false;

  // Parse in a detached document. Clipboard markup is never mounted in the app.
  const fragment = new DOMParser().parseFromString(html, "text/html");
  const destinations = Array.from(
    fragment.querySelectorAll("a[href]"),
    (link) => link.getAttribute("href")!,
  );
  const plainText = clipboard!.getData("text/plain");
  // Copy actions already put complete Markdown on the clipboard. Keep that
  // representation, including tables and formatting, whenever it carries the URLs.
  if (destinations.every((url) => plainText.includes(url))) return false;
  const text = markdown.turndown(fragment.body);
  input.focus();
  // Direct value assignment drops the textarea's undo history. This also emits
  // the normal input event so the editor publishes its new draft as for typing.
  return input.ownerDocument.execCommand("insertText", false, text);
}

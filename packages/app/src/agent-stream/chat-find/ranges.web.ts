import { findRenderedTextMatches } from "@/pane-find/rendered-matches.web";

/** Rendered rows carrying a source message identity, in reading order. */
export function findMessageRows(root: HTMLElement | null, messageId: string): HTMLElement[] {
  if (!root) return [];
  return Array.from(
    root.querySelectorAll<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`),
  );
}

/** Occurrences in one message, ordered by row and then by position inside the row. */
export function findMessageMatches(
  root: HTMLElement | null,
  messageId: string,
  query: string,
): Range[] {
  return findMessageRows(root, messageId).flatMap((row) => findRenderedMatches(row, query));
}

/** Local offsets belong to the DOM that supplied the text, never to a host parser. */
export function findRenderedMatches(row: HTMLElement, query: string): Range[] {
  // A plugin renderer owns the DOM of the message it replaced and sets no markers, so the
  // whole row is searched and each div (a React Native View or Text) bounds a match.
  if (row.dataset.pluginRow === "true")
    return findRenderedTextMatches([row], query, { divBlocks: true, visibleOnly: true });
  return findRenderedTextMatches(
    row.querySelectorAll<HTMLElement>('[data-message-text="true"]'),
    query,
  );
}

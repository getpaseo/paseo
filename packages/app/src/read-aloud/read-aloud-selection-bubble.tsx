/**
 * Read-aloud selection bubble, native fallback.
 *
 * The bubble is anchored to a live text selection, and native gives JS no way to
 * read one: `<Text selectable>` hands selection to the iOS edit menu or the
 * Android ActionMode, neither of which is reachable without a native module. So
 * there is nothing to anchor to and the component renders nothing. The real
 * implementation lives in `read-aloud-selection-bubble.web.tsx`.
 */
export function ReadAloudSelectionBubble(): null {
  return null;
}

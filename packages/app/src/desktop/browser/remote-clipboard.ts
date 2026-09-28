// Page-side functions for the daemon browser. The frame the pane shows is a picture,
// so selecting and copying has to happen in the daemon page and come back as text.

/** The selected text: an input's selected range, or the document selection. */
export const READ_SELECTION_FUNCTION = `() => {
  const active = document.activeElement;
  if (active && typeof active.selectionStart === "number" && typeof active.value === "string") {
    const selected = active.value.slice(active.selectionStart, active.selectionEnd ?? active.selectionStart);
    if (selected) return selected;
  }
  return String(window.getSelection() ?? "");
}`;

/** What a page's own copy button put on the daemon clipboard since the last read. */
export const TAKE_PAGE_COPY_FUNCTION = `() => {
  const copied = window.__paseoCopied;
  window.__paseoCopied = undefined;
  return copied && typeof copied.text === "string" ? copied.text : null;
}`;

export function parseEvaluatedText(result: {
  command: string;
  resultJson?: string;
}): string | null {
  if (result.command !== "evaluate" || !result.resultJson) return null;
  try {
    const value: unknown = JSON.parse(result.resultJson);
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

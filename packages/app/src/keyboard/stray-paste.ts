import type { KeyboardFocusScope } from "@/keyboard/actions";

function isTextEntryElement(target: EventTarget | null): boolean {
  if (typeof Element === "undefined" || !(target instanceof Element)) return false;
  const editable = target.closest("input, textarea, [contenteditable]");
  if (!editable) return false;
  return editable.getAttribute("contenteditable")?.toLowerCase() !== "false";
}

// Dictation tools paste wherever focus is, including the chat feed or nothing at all.
export function resolveStrayPasteText(input: {
  target: EventTarget | null;
  focusScope: KeyboardFocusScope;
  clipboardData: DataTransfer | null;
}): string | null {
  const { target, focusScope, clipboardData } = input;
  if (focusScope !== "other" && focusScope !== "message-input") return null;
  if (isTextEntryElement(target)) return null;
  if (!clipboardData || clipboardData.files.length > 0) return null;
  const text = clipboardData.getData("text/plain").replace(/\r\n?/g, "\n");
  return text.length > 0 ? text : null;
}

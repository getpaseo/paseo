/**
 * Module-local broadcaster for selection rects in the shared session.
 *
 * Two sources can produce selection rects:
 *   - DOM: window.getSelection() for plain text (chat, markdown, diff HTML).
 *   - Monaco: the in-editor selection, which is NOT visible to getSelection()
 *     because Monaco draws its own layer.
 *
 * To avoid the two paths racing (e.g. Monaco sends selection rects, then the
 * DOM source immediately sends empty-rects because document.getSelection() is
 * collapsed outside Monaco), we track which source currently "owns" the
 * broadcast. Only the owner can clear, but anyone can take over with non-empty
 * rects.
 */

import { getSharedSessionSnapshot } from "@/stores/shared-session-store";

export type SelectionSource = "dom" | "monaco";

export interface NormRect {
  anchorId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

let currentOwner: SelectionSource | null = null;
let lastSerialized = "";

export function broadcastSelectionRects(source: SelectionSource, rects: NormRect[]): void {
  const snap = getSharedSessionSnapshot();
  const room = snap.room;
  if (!room?.send) return;

  if (rects.length === 0) {
    // Only the current owner may clear. Prevents DOM's "nothing selected on
    // the document" from wiping the Monaco selection that's still active.
    if (currentOwner !== source) return;
    currentOwner = null;
  } else {
    currentOwner = source;
  }

  const serialized = `${rects.length}:${JSON.stringify(rects)}`;
  if (serialized === lastSerialized) return;
  lastSerialized = serialized;

  try {
    room.send("selection_rects", { rects });
  } catch {}
}

export function resetSelectionBroadcast(): void {
  currentOwner = null;
  lastSerialized = "";
}

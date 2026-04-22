/**
 * Broadcasts the current Monaco editor selection to the shared-session peers,
 * using the same `selection_rects` channel the DOM overlay renders.
 *
 * Monaco draws its selection on a custom layer — document.getSelection() never
 * reflects what the user actually highlighted. We compute on-screen rects from
 * the selection's line ranges via `getScrolledVisiblePosition()`, clip to the
 * shared viewport, normalize 0..1, and push through the shared broadcaster.
 */

import { useEffect } from "react";
import {
  broadcastSelectionRects,
  type NormRect,
} from "@/components/sharing/shared-selection-broadcaster";
import { useIsInSharedSession } from "@/stores/shared-session-store";

const ANCHOR_PREFIX = "shared-anchor-";

function findSharedAnchor(el: HTMLElement | null): HTMLElement | null {
  let cur: HTMLElement | null = el;
  while (cur) {
    if (cur.id?.startsWith(ANCHOR_PREFIX)) return cur;
    cur = cur.parentElement;
  }
  return null;
}

// Local structural types — avoids a direct dependency on monaco-editor types,
// which aren't installed as a typings dep in this workspace.
interface IDisposable {
  dispose(): void;
}
interface ISelection {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}
interface ITextModel {
  getLineLength(line: number): number;
}

const THROTTLE_MS = 80;
const MAX_RECTS = 60;

interface MonacoEditorLike {
  onDidChangeCursorSelection(cb: () => void): IDisposable;
  onDidScrollChange(cb: () => void): IDisposable;
  onDidLayoutChange?(cb: () => void): IDisposable;
  onDidBlurEditorWidget?(cb: () => void): IDisposable;
  getSelection(): ISelection | null;
  getModel(): ITextModel | null;
  getScrolledVisiblePosition(position: {
    lineNumber: number;
    column: number;
  }): { top: number; left: number; height: number } | null;
  getDomNode(): HTMLElement | null;
}

/**
 * Attach to one or more Monaco code editors. The `getEditors` callback is
 * invoked each render — return the live editor instances (for a DiffEditor,
 * that's both the original + modified side). Null/undefined entries are safe.
 */
export function useMonacoSelectionSync(getEditors: () => Array<MonacoEditorLike | null>) {
  const isInSharedSession = useIsInSharedSession();

  useEffect(() => {
    if (!isInSharedSession) return;
    const editors = getEditors().filter((e): e is MonacoEditorLike => !!e);
    if (editors.length === 0) return;

    let lastSendAt = 0;
    let pending: ReturnType<typeof setTimeout> | null = null;

    const computeRects = (ed: MonacoEditorLike): NormRect[] => {
      const selection = ed.getSelection();
      const model = ed.getModel();
      const domNode = ed.getDomNode();
      if (!selection || !model || !domNode) return [];
      if (
        selection.startLineNumber === selection.endLineNumber &&
        selection.startColumn === selection.endColumn
      ) {
        return [];
      }
      // Anchor rects to the nearest shared message anchor — the same scheme
      // the DOM selection path uses. If this editor isn't inside a shared
      // stream item, we can't sync (no stable cross-client coordinate frame).
      const anchor = findSharedAnchor(domNode);
      if (!anchor) return [];
      const anchorRect = anchor.getBoundingClientRect();
      const editorRect = domNode.getBoundingClientRect();

      const rects: NormRect[] = [];
      const startLine = selection.startLineNumber;
      const endLine = selection.endLineNumber;

      for (let line = startLine; line <= endLine && rects.length < MAX_RECTS; line++) {
        const lineLength = model.getLineLength(line);
        const startCol = line === startLine ? selection.startColumn : 1;
        const endCol = line === endLine ? selection.endColumn : lineLength + 1;
        if (endCol <= startCol) continue;

        const startPos = ed.getScrolledVisiblePosition({ lineNumber: line, column: startCol });
        const endPos = ed.getScrolledVisiblePosition({ lineNumber: line, column: endCol });
        if (!startPos || !endPos) continue;
        if (endPos.top + endPos.height < 0) continue;
        if (startPos.top > editorRect.height) continue;

        const vpLeft = editorRect.left + startPos.left;
        const vpTop = editorRect.top + startPos.top;
        const vpRight = editorRect.left + endPos.left;
        const vpBottom = vpTop + startPos.height;

        const clippedLeft = Math.max(vpLeft, editorRect.left);
        const clippedTop = Math.max(vpTop, editorRect.top);
        const clippedRight = Math.min(vpRight, editorRect.right);
        const clippedBottom = Math.min(vpBottom, editorRect.bottom);
        const w = clippedRight - clippedLeft;
        const h = clippedBottom - clippedTop;
        if (w <= 0 || h <= 0) continue;

        rects.push({
          anchorId: anchor.id.slice(ANCHOR_PREFIX.length),
          x: clippedLeft - anchorRect.left,
          y: clippedTop - anchorRect.top,
          w,
          h,
        });
      }

      return rects;
    };

    const emit = () => {
      // Pick the first editor with a non-empty selection; Monaco's DiffEditor
      // only allows selection in one side at a time.
      let rects: NormRect[] = [];
      for (const ed of editors) {
        const r = computeRects(ed);
        if (r.length > 0) {
          rects = r;
          break;
        }
      }
      broadcastSelectionRects("monaco", rects);
    };

    const scheduleEmit = () => {
      const now = Date.now();
      const elapsed = now - lastSendAt;
      if (elapsed >= THROTTLE_MS) {
        lastSendAt = now;
        emit();
      } else if (!pending) {
        pending = setTimeout(() => {
          pending = null;
          lastSendAt = Date.now();
          emit();
        }, THROTTLE_MS - elapsed);
      }
    };

    const disposables: IDisposable[] = [];
    for (const ed of editors) {
      disposables.push(ed.onDidChangeCursorSelection(scheduleEmit));
      disposables.push(ed.onDidScrollChange(scheduleEmit));
      if (ed.onDidLayoutChange) disposables.push(ed.onDidLayoutChange(scheduleEmit));
    }
    // Also follow window resize/scroll — the editor's own layout events don't
    // fire when the surrounding page scrolls.
    const onWindow = () => scheduleEmit();
    window.addEventListener("resize", onWindow);
    window.addEventListener("scroll", onWindow, true);

    // Initial push in case the user already has a selection at mount.
    scheduleEmit();

    return () => {
      for (const d of disposables) {
        try {
          d.dispose();
        } catch {}
      }
      window.removeEventListener("resize", onWindow);
      window.removeEventListener("scroll", onWindow, true);
      if (pending) clearTimeout(pending);
      broadcastSelectionRects("monaco", []);
    };
  }, [isInSharedSession, getEditors]);
}

import { useEffect, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { createDomFindEngine } from "@/find/dom/engine.web";
import { getFindHighlights } from "@/find/dom/highlights.web";
import type { FindEngine } from "@/find/engine";
import { useFindSurface, type UseFindSurfaceResult } from "@/find/use-find-surface";
import { createCodeMirrorFindEngine } from "./codemirror-engine.web";

export interface UseFileFindInput {
  /** `isWeb && useRetainedPanelActive()`; the hook adds its own readiness on top. */
  enabled: boolean;
  /** The CodeMirror view behind the editor and read-only source modes. */
  editorView: EditorView | null;
  /** The Markdown preview's scroll node. */
  previewScrollElement: HTMLElement | null;
  /** The pane's content region, which also contains the find bar. */
  getRoot: () => HTMLElement | null;
}

export type UseFileFindResult = UseFindSurfaceResult | null;

/**
 * Find for the file pane, across the modes one pane switches between.
 *
 * Each mode brings its own text store, so the engine is swapped rather than adapted:
 * CodeMirror owns the source and editor modes, the shared DOM engine owns the rendered
 * Markdown preview, and HTML previews, images and binaries have no engine at all — in
 * those modes the surface stays unregistered and Cmd+F falls through to the browser.
 * The typed query survives a mode switch because `useFindSurface` re-applies it to
 * whatever engine appears next.
 */
export function useFileFind({
  enabled,
  editorView,
  previewScrollElement,
  getRoot,
}: UseFileFindInput): UseFileFindResult {
  const [engine, setEngine] = useState<FindEngine | null>(null);
  const searchable = editorView !== null || previewScrollElement !== null;

  useEffect(() => {
    const created = createEngine({ enabled, editorView, previewScrollElement });
    setEngine(created);
    if (!created) {
      return;
    }
    return () => {
      created.dispose();
      setEngine(null);
    };
  }, [editorView, enabled, previewScrollElement]);

  return useFindSurface({
    name: "file",
    engine,
    enabled: enabled && searchable,
    getRoot,
  });
}

function createEngine(input: {
  enabled: boolean;
  editorView: EditorView | null;
  previewScrollElement: HTMLElement | null;
}): FindEngine | null {
  if (!input.enabled) {
    return null;
  }
  if (input.editorView) {
    return createCodeMirrorFindEngine(input.editorView);
  }
  const scrollElement = input.previewScrollElement;
  if (scrollElement) {
    return createDomFindEngine({
      getRoots: () => [scrollElement],
      getScrollElement: () => scrollElement,
      highlights: getFindHighlights(),
    });
  }
  return null;
}

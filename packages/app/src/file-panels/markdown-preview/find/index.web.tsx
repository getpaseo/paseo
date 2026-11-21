import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { View, type ScrollView, type View as ViewInstance } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { PaneFind, findShortcutPlatform, isFindShortcut, type PaneFindHandle } from "@/pane-find";
import { findRenderedTextMatches } from "@/pane-find/rendered-matches.web";
import { usePaneFocus } from "@/panels/pane-context";
import { hasActiveOverlay } from "@/keyboard";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { isImeComposingKeyboardEvent } from "@/utils/keyboard-ime";
import { MarkdownFindModel } from "./model";
import type { MarkdownPreviewFindProps } from "./types";

let nextHighlightId = 0;

// RN Web hands the underlying DOM element to a View ref.
function viewNode(view: ViewInstance | null): HTMLElement | null {
  return view as unknown as HTMLElement | null;
}
function scrollNode(scroller: ScrollView | null): HTMLElement | null {
  return (scroller?.getScrollableNode() as HTMLElement | undefined) ?? null;
}

/**
 * Scroll the match into the part of the scroller the widget does not cover, a third of
 * the way down. A match that is already in that part stays put.
 */
function reveal(match: Range, scroller: HTMLElement | null, widget: HTMLElement | null) {
  if (!scroller) return;
  const box = match.getBoundingClientRect();
  const frame = scroller.getBoundingClientRect();
  const top = widget ? Math.max(frame.top, widget.getBoundingClientRect().bottom + 8) : frame.top;
  if (box.top >= top && box.bottom <= frame.bottom) return;
  scroller.scrollBy({ top: box.top - (top + (frame.bottom - top) / 3) });
}

export function MarkdownPreviewFind({ content, scroller }: MarkdownPreviewFindProps) {
  const { t } = useTranslation();
  const widget = useRef<PaneFindHandle>(null);
  const widgetNode = useRef<HTMLElement | null>(null);
  const { isInteractive } = usePaneFocus();
  const active = useRetainedPanelActive();
  const [highlights] = useState(() => {
    const id = ++nextHighlightId;
    return { all: `paseo-markdown-find-${id}`, current: `paseo-markdown-find-current-${id}` };
  });
  const [model] = useState(
    () =>
      new MarkdownFindModel<Range>({
        search(query) {
          const root = viewNode(content.current);
          // Front matter and code lines are React Native Views, so divs bound matches too.
          return root ? findRenderedTextMatches([root], query, { divBlocks: true }) : [];
        },
        show(matches, current, revealCurrent) {
          const selected = new Highlight(matches[current]!);
          selected.priority = 1;
          CSS.highlights.set(highlights.all, new Highlight(...matches));
          CSS.highlights.set(highlights.current, selected);
          if (revealCurrent)
            reveal(matches[current]!, scrollNode(scroller.current), widgetNode.current);
        },
        clear() {
          CSS.highlights.delete(highlights.all);
          CSS.highlights.delete(highlights.current);
        },
      }),
  );
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const setWidgetNode = useCallback((node: ViewInstance | null) => {
    widgetNode.current = viewNode(node);
  }, []);

  useEffect(() => () => model.close(), [model]);
  useEffect(() => {
    if (!active) model.close();
  }, [active, model]);
  useEffect(() => {
    if (!isInteractive || !active) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || hasActiveOverlay() || isImeComposingKeyboardEvent(event))
        return;
      if (isFindShortcut(event, findShortcutPlatform())) {
        event.preventDefault();
        model.open();
        widget.current?.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active, isInteractive, model]);
  // Edits to the file re-render the document, which detaches the painted ranges.
  useEffect(() => {
    const root = viewNode(content.current);
    if (!state.open || !root) return;
    let frame = 0;
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(model.refresh);
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [content, model, state.open]);

  let status = "";
  if (state.query.trim())
    status = state.total
      ? t("paneFind.position", { current: state.current + 1, total: state.total })
      : t("paneFind.noMatches");
  return (
    <>
      <style>{`::highlight(${highlights.all}) { background-color: ${styles.match.backgroundColor}; } ::highlight(${highlights.current}) { background-color: ${styles.current.backgroundColor}; color: ${styles.current.color}; }`}</style>
      {state.open ? (
        <View style={styles.overlay} pointerEvents="box-none">
          <View ref={setWidgetNode} style={styles.widget}>
            <PaneFind
              ref={widget}
              query={state.query}
              status={status}
              canNavigate={state.total > 0}
              onQueryChange={model.setQuery}
              onNext={model.next}
              onPrevious={model.previous}
              onClose={model.close}
            />
          </View>
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  overlay: {
    position: "absolute",
    top: theme.spacing[2],
    left: theme.spacing[2],
    right: theme.spacing[2],
    alignItems: "flex-end",
    zIndex: 1,
  },
  // Bounds the widget to the pane; PaneFind's own maxWidth resolves against this.
  widget: { maxWidth: "100%" },
  match: { backgroundColor: theme.colors.terminal.selectionBackground },
  current: { backgroundColor: theme.colors.statusWarning, color: theme.colors.surface0 },
}));

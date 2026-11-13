import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { View, type View as ViewInstance } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { PaneFind, findShortcutPlatform, isFindShortcut, type PaneFindHandle } from "@/pane-find";
import { usePaneFocus } from "@/panels/pane-context";
import { hasActiveOverlay } from "@/keyboard";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { isImeComposingKeyboardEvent } from "@/utils/keyboard-ime";
import { MarkdownPreviewFindModel } from "./model.web";
import type { MarkdownPreviewFindProps } from "./types";

const ROOT_STYLE = {
  display: "flex",
  flex: 1,
  minHeight: 0,
  minWidth: 0,
  position: "relative",
  outline: "none",
} as const;

let nextHighlightId = 0;

export function MarkdownPreviewFind({ source, children }: MarkdownPreviewFindProps) {
  const { t } = useTranslation();
  const widget = useRef<PaneFindHandle>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const [highlightNames] = useState(() => {
    const id = ++nextHighlightId;
    return {
      all: `paseo-markdown-find-${id}`,
      active: `paseo-markdown-find-active-${id}`,
    };
  });
  const [model] = useState(() => new MarkdownPreviewFindModel(highlightNames));
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const { isInteractive } = usePaneFocus();
  const active = useRetainedPanelActive();

  const setRootNode = useCallback(
    (node: HTMLDivElement | null) => {
      root.current = node;
      model.setRootNode(node);
    },
    [model],
  );
  const setWidgetNode = useCallback(
    (node: ViewInstance | null) => model.setWidgetNode(node as unknown as HTMLElement | null),
    [model],
  );

  useEffect(() => () => model.dispose(), [model]);
  useEffect(() => {
    if (!active) model.close();
  }, [active, model]);

  useEffect(() => {
    model.refreshContent();
  }, [model, source]);

  useEffect(() => {
    if (!state.open || !state.query) return;
    const frame = root.current?.querySelector<HTMLElement>(
      '[data-testid="markdown-preview-frame"]',
    );
    if (!frame || typeof MutationObserver === "undefined") return;
    let raf = 0;
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => model.refreshContent());
    });
    observer.observe(frame, { childList: true, characterData: true, subtree: true });
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [model, state.open, state.query]);

  useEffect(() => {
    if (!isInteractive || !active) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || hasActiveOverlay() || isImeComposingKeyboardEvent(event)) {
        return;
      }
      if (isFindShortcut(event, findShortcutPlatform())) {
        event.preventDefault();
        model.open();
        widget.current?.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [active, isInteractive, model]);

  const close = useCallback(() => {
    model.close();
    root.current?.focus({ preventScroll: true });
  }, [model]);

  const total = `${state.total}${state.limited ? "+" : ""}`;
  let status = "";
  if (state.query) {
    if (state.total === 0) status = t("paneFind.noMatches");
    else if (state.current) status = t("paneFind.position", { current: state.current, total });
    else status = t("paneFind.total", { total });
  }

  return (
    <div ref={setRootNode} tabIndex={-1} data-testid="markdown-preview-surface" style={ROOT_STYLE}>
      <style>{`::highlight(${highlightNames.all}) { background-color: ${styles.highlight.backgroundColor}; } ::highlight(${highlightNames.active}) { background-color: ${styles.activeHighlight.backgroundColor}; color: ${styles.activeHighlight.color}; }`}</style>
      {children}
      {state.open ? (
        <View
          style={[
            styles.overlay,
            state.placement === "top" ? styles.overlayTop : styles.overlayBottom,
          ]}
          pointerEvents="box-none"
        >
          <View ref={setWidgetNode} style={styles.widget}>
            <PaneFind
              ref={widget}
              query={state.query}
              status={status}
              canNavigate={state.total > 0}
              onQueryChange={model.setSearch}
              onNext={model.next}
              onPrevious={model.previous}
              onClose={close}
            />
          </View>
        </View>
      ) : null}
    </div>
  );
}

const styles = StyleSheet.create((theme) => ({
  overlay: {
    position: "absolute",
    left: theme.spacing[2],
    right: theme.spacing[2],
    alignItems: "flex-end",
    zIndex: 1,
  },
  widget: { maxWidth: "100%" },
  overlayTop: { top: theme.spacing[2] },
  overlayBottom: { bottom: theme.spacing[2] },
  highlight: { backgroundColor: theme.colors.statusWarningTint },
  activeHighlight: {
    backgroundColor: theme.colors.statusWarning,
    color: theme.colors.surface0,
  },
}));

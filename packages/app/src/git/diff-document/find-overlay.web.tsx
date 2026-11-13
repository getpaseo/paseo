import { useCallback, useEffect, useRef, useSyncExternalStore, type RefObject } from "react";
import { View, type View as ViewInstance } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { PaneFind, findShortcutPlatform, isFindShortcut, type PaneFindHandle } from "@/pane-find";
import { useOptionalPaneFocus } from "@/panels/pane-context";
import { hasActiveOverlay } from "@/keyboard";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { isImeComposingKeyboardEvent } from "@/utils/keyboard-ime";
import type { DiffFindModel } from "./find-model.web";

export function DiffFindOverlay({
  model,
  scrollRef,
}: {
  model: DiffFindModel;
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation();
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const widget = useRef<PaneFindHandle>(null);
  const paneFocus = useOptionalPaneFocus();
  const isInteractive = paneFocus ? paneFocus.isInteractive : true;
  const active = useRetainedPanelActive();

  const setWidgetNode = useCallback(
    (node: ViewInstance | null) => model.setWidgetNode(node as unknown as HTMLElement | null),
    [model],
  );

  useEffect(() => {
    if (!active) model.close();
  }, [active, model]);

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
    scrollRef.current?.focus({ preventScroll: true });
  }, [model, scrollRef]);

  if (!state.open) return null;

  const total = `${state.total}${state.limited ? "+" : ""}`;
  let status = "";
  if (state.query) {
    if (state.total === 0) status = t("paneFind.noMatches");
    else if (state.current) status = t("paneFind.position", { current: state.current, total });
    else status = t("paneFind.total", { total });
  }

  return (
    <View
      style={[styles.overlay, state.placement === "top" ? styles.overlayTop : styles.overlayBottom]}
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
  );
}

const styles = StyleSheet.create((theme) => ({
  overlay: {
    position: "absolute",
    left: theme.spacing[2],
    right: theme.spacing[2],
    alignItems: "flex-end",
    zIndex: 10,
  },
  widget: { maxWidth: "100%" },
  overlayTop: { top: theme.spacing[2] },
  overlayBottom: { bottom: theme.spacing[2] },
}));

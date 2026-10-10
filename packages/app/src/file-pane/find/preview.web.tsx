import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { View, type View as ViewInstance } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { PaneFind, findShortcutPlatform, isFindShortcut, type PaneFindHandle } from "@/pane-find";
import { usePaneFocus } from "@/panels/pane-context";
import { hasActiveWebOverlay } from "@/lib/overlay-root";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { isImeComposingKeyboardEvent } from "@/utils/keyboard-ime";
import { PreviewFindModel, type PreviewFindSnapshot } from "./preview-model.web";

const WIDGET_DATASET = { paseoFileFind: "" };
const subscribeNothing = () => () => {};
const CLOSED_SNAPSHOT: PreviewFindSnapshot = {
  open: false,
  query: "",
  current: 0,
  total: 0,
  limited: false,
};

/**
 * Cmd+F over a rendered preview (Markdown). The editor and source views mount
 * FileFind, which talks to CodeMirror; this mounts the same widget but drives
 * PreviewFindModel, which highlights the preview's rendered text DOM.
 */
export function FilePreviewFind({ host }: { host: RefObject<ViewInstance | null> }) {
  const { t } = useTranslation();
  const { isInteractive } = usePaneFocus();
  const active = useRetainedPanelActive();
  const widget = useRef<PaneFindHandle>(null);
  const [model, setModel] = useState<PreviewFindModel | null>(null);

  useEffect(() => {
    // RN Web hands the underlying DOM element to a View ref.
    const element = host.current as unknown as HTMLElement | null;
    if (!element) return;
    const next = new PreviewFindModel(element);
    setModel(next);
    return () => {
      next.dispose();
      setModel(null);
    };
  }, [host]);

  const state = useSyncExternalStore(
    model?.subscribe ?? subscribeNothing,
    model?.getSnapshot ?? (() => CLOSED_SNAPSHOT),
    () => CLOSED_SNAPSHOT,
  );

  useEffect(() => {
    if (!isInteractive || !active || !model) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || hasActiveWebOverlay() || isImeComposingKeyboardEvent(event))
        return;
      if (isFindShortcut(event, findShortcutPlatform())) {
        event.preventDefault();
        model?.open();
        widget.current?.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active, isInteractive, model]);

  if (!model || !state.open) return null;
  const total = `${state.total}${state.limited ? "+" : ""}`;
  let status = "";
  if (state.query) {
    if (state.total === 0) status = t("paneFind.noMatches");
    else if (state.current) status = t("paneFind.position", { current: state.current, total });
    else status = t("paneFind.total", { total });
  }
  return (
    <View style={styles.overlay} pointerEvents="box-none">
      <View style={styles.widget} dataSet={WIDGET_DATASET}>
        <PaneFind
          ref={widget}
          query={state.query}
          status={status}
          canNavigate={state.total > 0}
          onQueryChange={model.setSearch}
          onNext={model.next}
          onPrevious={model.previous}
          onClose={model.close}
        />
      </View>
    </View>
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
  widget: { maxWidth: "100%" },
}));

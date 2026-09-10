import {
  useCallback,
  useMemo,
  useEffect,
  useRef,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { EditorView } from "@codemirror/view";
import { View, type View as ViewInstance } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { PaneFind, type PaneFindHandle } from "@/pane-find";
import { usePaneFocusIfAny } from "@/panels/pane-context";
import { hasActiveWebOverlay } from "@/lib/overlay-root";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { isImeComposingKeyboardEvent } from "@/utils/keyboard-ime";
import { FileFindModel } from "./model.web";

export { FileFindModel } from "./model.web";

export function FileFind({
  model,
  editor,
}: {
  model: FileFindModel;
  editor: RefObject<EditorView | null>;
}) {
  const { t } = useTranslation();
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const widget = useRef<PaneFindHandle>(null);
  // A source view can also render outside any pane, such as the Command Center content
  // preview. Pane Find belongs to the pane, so there is nothing to open there.
  const pane = usePaneFocusIfAny();
  const active = useRetainedPanelActive();
  // RN Web hands the underlying DOM element to a View ref; the model measures it.
  const setWidgetNode = useCallback(
    (node: ViewInstance | null) => model.setWidgetNode(node as unknown as HTMLElement | null),
    [model],
  );
  useEffect(() => {
    if (!pane?.isInteractive || !active) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || hasActiveWebOverlay() || isImeComposingKeyboardEvent(event))
        return;
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "f"
      ) {
        event.preventDefault();
        model.open(editor.current);
        widget.current?.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active, editor, model, pane?.isInteractive]);

  const replace = useMemo(
    () =>
      state.readOnly
        ? undefined
        : {
            value: state.replacement,
            onChange: model.setReplacement,
            onReplace: model.replace,
            onReplaceAll: model.replaceAll,
          },
    [model, state.readOnly, state.replacement],
  );
  if (!pane || !state.open) return null;
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
          onClose={model.close}
          replace={replace}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // The widget floats over the content; the model flips the corner when it would
  // otherwise sit on top of the active match.
  overlay: {
    position: "absolute",
    left: theme.spacing[2],
    right: theme.spacing[2],
    alignItems: "flex-end",
    zIndex: 1,
  },
  // Bounds the widget to the pane; PaneFind's own maxWidth resolves against this.
  widget: { maxWidth: "100%" },
  overlayTop: { top: theme.spacing[2] },
  overlayBottom: { bottom: theme.spacing[2] },
}));

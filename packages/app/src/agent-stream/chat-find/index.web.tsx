import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { View, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { PaneFind, type PaneFindHandle } from "@/pane-find";
import { Button } from "@/components/ui/button";
import { usePaneFocus } from "@/panels/pane-context";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { hasActiveWebOverlay } from "@/lib/overlay-root";
import { isImeComposingKeyboardEvent } from "@/utils/keyboard-ime";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { planTimelinePromptJump } from "@/timeline/timeline-sync-plan";
import { ChatFindModel } from "./model";
import { createFindViewport } from "./viewport.web";
import type { ChatFindProps, ChatFindExpansionProps } from "./types";

const Expansion = createContext<string | null>(null);
const WIDGET_DATASET = { chatFindWidget: "true" };
const ROOT_STYLE = {
  display: "flex",
  flex: 1,
  minHeight: 0,
  position: "relative",
  outline: "none",
} as const;
let nextHighlightId = 0;

export function ChatFindExpansion({ itemId, children }: ChatFindExpansionProps) {
  return children(useContext(Expansion) === itemId);
}

export function ChatFind({
  agentId,
  serverId,
  epoch,
  items,
  viewportRef,
  revealLoadedItem,
  visibleItemIds,
  children,
}: ChatFindProps) {
  const { t } = useTranslation();
  const widget = useRef<PaneFindHandle>(null);
  const root = useRef<HTMLDivElement>(null);
  const bindings = useRef({ viewportRef, revealLoadedItem, visibleItemIds });
  bindings.current = { viewportRef, revealLoadedItem, visibleItemIds };
  const [highlightName] = useState(() => `paseo-chat-find-${++nextHighlightId}`);
  const { isInteractive } = usePaneFocus();
  const active = useRetainedPanelActive();
  const model = useMemo(
    () =>
      new ChatFindModel({
        search(query, cursor) {
          const client = getHostRuntimeStore().getClient(serverId);
          if (!client) return Promise.reject(new Error("Host disconnected"));
          return client.searchAgentTimeline({ agentId, query, cursor });
        },
        load(targetEpoch, seq) {
          return getHostRuntimeStore().fetchAgentTimeline(
            serverId,
            agentId,
            planTimelinePromptJump({ epoch: targetEpoch, seq }),
          );
        },
        ...createFindViewport({
          getBindings: () => bindings.current,
          getRoot: () => root.current,
          highlightName,
        }),
      }),
    [agentId, serverId, highlightName],
  );
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  useEffect(() => {
    model.updateHistory(epoch, items);
  }, [model, epoch, items]);
  useEffect(() => () => model.close(), [model]);
  useEffect(() => {
    if (!active) model.close();
  }, [active, model]);
  useEffect(() => {
    if (!active || !isInteractive) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || hasActiveWebOverlay() || isImeComposingKeyboardEvent(event))
        return;
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "f"
      ) {
        event.preventDefault();
        model.open();
        widget.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active, isInteractive, model]);
  const close = useCallback(() => {
    model.close();
    root.current?.focus({ preventScroll: true });
  }, [model]);
  let status = "";
  if (state.phase === "searching") status = t("paneFind.searching");
  else if (state.phase === "loading") status = t("paneFind.loading");
  else if (state.phase === "error") status = t("paneFind.failed");
  else if (state.query.trim())
    status = state.count
      ? t("paneFind.chatPosition", { current: state.occurrence + 1, total: state.count })
      : t("paneFind.noMatches");
  return (
    <div ref={root} tabIndex={-1} style={ROOT_STYLE}>
      <style>{`::highlight(${highlightName}) { background-color: ${styles.highlight.backgroundColor}; color: ${styles.highlight.color}; }`}</style>
      <Expansion.Provider value={state.selectedItemId}>{children}</Expansion.Provider>
      {state.open && (
        <View style={styles.overlay} dataSet={WIDGET_DATASET}>
          <PaneFind
            ref={widget}
            query={state.query}
            status={status}
            canNavigate={state.phase === "ready" && state.count > 0}
            onQueryChange={model.setQuery}
            onNext={model.next}
            onPrevious={model.previous}
            onClose={close}
          />
          {state.error && (
            <View style={styles.error}>
              <Text style={styles.errorText}>{t("paneFind.searchFailed")}</Text>
              <Button size="xs" variant="ghost" onPress={model.retry}>
                {t("paneFind.retry")}
              </Button>
            </View>
          )}
        </View>
      )}
    </div>
  );
}
const styles = StyleSheet.create((theme) => ({
  overlay: {
    position: "absolute",
    top: theme.spacing[2],
    right: theme.spacing[3],
    zIndex: 10,
    maxWidth: "100%",
  },
  error: {
    flexDirection: "row",
    alignItems: "center",
    padding: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
  },
  errorText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm, flex: 1 },
  highlight: { backgroundColor: theme.colors.statusWarning, color: theme.colors.surface0 },
}));

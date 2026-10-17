import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { hasActiveWebOverlay } from "@/lib/overlay-root";
import { isImeComposingKeyboardEvent } from "@/utils/keyboard-ime";
import { DiffFindModel } from "./model";
import { PaneFind, type PaneFindHandle } from "@/pane-find";

export function useDiffFind(
  files: readonly ParsedDiffFile[],
  root: RefObject<HTMLDivElement | null>,
) {
  const [model] = useState(() => new DiffFindModel());
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const widget = useRef<PaneFindHandle>(null);
  const container = useRef<HTMLDivElement>(null);
  const active = useRetainedPanelActive();
  useLayoutEffect(() => model.setFiles(files), [files, model]);
  useEffect(() => () => model.dispose(), [model]);
  useEffect(() => {
    if (!active) model.close();
  }, [active, model]);
  useEffect(() => {
    if (!active) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || hasActiveWebOverlay() || isImeComposingKeyboardEvent(event))
        return;
      const findKey =
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "f";
      if (!findKey) return;
      // Compact/themed surfaces may mount outside PaneFocusContext. Keyboard ownership
      // comes from the actual focused DOM scope, not a desktop-only provider.
      const scope = root.current?.closest("[data-diff-find-scope]") ?? root.current;
      if (!(event.target instanceof Node) || !scope?.contains(event.target)) return;
      event.preventDefault();
      model.open();
      widget.current?.focus();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active, model, root]);
  return { model, snapshot, widget, container };
}

export function DiffFindOverlay({
  find,
  placement,
  scroll,
}: {
  find: ReturnType<typeof useDiffFind>;
  placement: "top" | "bottom";
  scroll: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation();
  const { model, snapshot, widget, container } = find;
  const close = useCallback(() => {
    model.close();
    scroll.current?.focus();
  }, [model, scroll]);
  if (snapshot.phase === "closed") return null;
  const ready = snapshot.phase === "ready";
  const total = `${snapshot.matches.length}${snapshot.limited ? "+" : ""}`;
  let status = "";
  if (!ready) status = t("diffFind.searching");
  else if (snapshot.query && snapshot.matches.length === 0) status = t("paneFind.noMatches");
  else if (snapshot.matches.length)
    status = t("paneFind.position", { current: snapshot.current + 1, total });
  const current = snapshot.matches[snapshot.current];
  return (
    <div
      ref={container}
      data-testid="diff-find"
      aria-label={t("diffFind.title")}
      style={placement === "top" ? TOP_STYLE : BOTTOM_STYLE}
      onContextMenu={stopContextMenu}
    >
      <PaneFind
        ref={widget}
        query={snapshot.query}
        status={status}
        canNavigate={ready && snapshot.matches.length > 0}
        onQueryChange={model.setQuery}
        onNext={model.next}
        onPrevious={model.previous}
        onClose={close}
      />
      <View style={styles.caption}>
        <Text style={styles.hint} numberOfLines={1}>
          {t("diffFind.scope")}
        </Text>
        {snapshot.skippedFiles > 0 ? (
          <Text style={styles.hint}>{t("diffFind.skipped", { count: snapshot.skippedFiles })}</Text>
        ) : null}
        {current ? (
          <Text style={styles.hint} numberOfLines={1} testID="diff-find-active-file">
            {current.file.path}
          </Text>
        ) : null}
      </View>
    </div>
  );
}

function stopContextMenu(event: React.MouseEvent): void {
  event.stopPropagation();
}

const OVERLAY_STYLE: React.CSSProperties = {
  position: "absolute",
  right: 8,
  maxWidth: "calc(100% - 16px)",
  width: 340,
  zIndex: 6,
};
const TOP_STYLE: React.CSSProperties = { ...OVERLAY_STYLE, top: 8 };
const BOTTOM_STYLE: React.CSSProperties = { ...OVERLAY_STYLE, bottom: 8 };
const styles = StyleSheet.create((theme) => ({
  caption: {
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));

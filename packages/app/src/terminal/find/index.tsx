import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type RefObject,
} from "react";
import { View, type LayoutChangeEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { PaneFind, type PaneFindHandle } from "@/pane-find";
import { isWeb } from "@/constants/platform";
import { hasActiveWebOverlay } from "@/lib/overlay-root";
import { isImeComposingKeyboardEvent } from "@/utils/keyboard-ime";
import type { TerminalEmulatorHandle } from "@/components/terminal-emulator-contract";
import type { TerminalFindResult } from "../runtime/terminal-emulator-runtime";

export interface TerminalPaneFindHandle {
  open(): void;
  update(result: TerminalFindResult): void;
  reset(): void;
}

export const TerminalFind = forwardRef<
  TerminalPaneFindHandle,
  {
    terminal: RefObject<TerminalEmulatorHandle | null>;
    active: boolean;
    focusTerminal(): void;
  }
>(function TerminalFind({ terminal, active, focusTerminal }, ref) {
  const { t } = useTranslation();
  const widget = useRef<PaneFindHandle>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<TerminalFindResult>({
    resultIndex: -1,
    resultCount: 0,
    limited: false,
    placement: "top",
  });
  const show = useCallback(() => {
    if (!active || !terminal.current?.find) return;
    if (!open && query) terminal.current.find.search(query);
    setOpen(true);
    widget.current?.focus();
  }, [active, open, query, terminal]);
  useImperativeHandle(
    ref,
    () => ({
      open: show,
      update: setResult,
      reset: () => {
        setOpen(false);
        setQuery("");
      },
    }),
    [show],
  );
  useEffect(() => {
    if (!isWeb || !active) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || hasActiveWebOverlay() || isImeComposingKeyboardEvent(event))
        return;
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "f" &&
        terminal.current?.find
      ) {
        event.preventDefault();
        show();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active, show, terminal]);
  const search = useCallback(
    (text: string) => {
      setQuery(text);
      terminal.current?.find?.search(text);
    },
    [terminal],
  );
  const next = useCallback(() => terminal.current?.find?.search(query, "next"), [query, terminal]);
  const previous = useCallback(
    () => terminal.current?.find?.search(query, "previous"),
    [query, terminal],
  );
  const measureWidget = useCallback(
    (event: LayoutChangeEvent) => {
      const { width, height } = event.nativeEvent.layout;
      terminal.current?.find?.setWidgetSize({ width, height });
    },
    [terminal],
  );
  const close = useCallback(() => {
    terminal.current?.find?.clear();
    setOpen(false);
    focusTerminal();
  }, [focusTerminal, terminal]);
  if (!open || !terminal.current?.find) return null;
  const total = `${result.resultCount}${result.limited ? "+" : ""}`;
  let status = "";
  if (query) {
    if (result.resultCount === 0) status = t("paneFind.noMatches");
    else if (result.resultIndex < 0) status = t("paneFind.total", { total });
    else status = t("paneFind.position", { current: result.resultIndex + 1, total });
  }
  return (
    <View
      pointerEvents="box-none"
      style={[styles.overlay, result.placement === "top" ? styles.top : styles.bottom]}
    >
      <View onLayout={measureWidget} style={styles.frame}>
        <PaneFind
          ref={widget}
          query={query}
          status={status}
          canNavigate={result.resultCount > 0}
          onQueryChange={search}
          onNext={next}
          onPrevious={previous}
          onClose={close}
        />
      </View>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  overlay: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "flex-end",
    zIndex: 2,
  },
  frame: { maxWidth: "100%", padding: theme.spacing[2] },
  top: { top: 0 },
  bottom: { bottom: 0 },
}));

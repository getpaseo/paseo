import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { isWeb } from "@/constants/platform";
import type { FindEngine, FindResult } from "@/find/engine";
import { EMPTY_FIND_RESULT } from "@/find/model";
import { registerFindSurface, resolveActiveFindSurface } from "@/find/surface-registry";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import { buildWorkspaceKeyboardHandlerId } from "@/keyboard/handler-id";
import { usePaneContext, usePaneFocus } from "@/panels/pane-context";

export type FindSurfaceName = "transcript" | "terminal" | "file";

export interface UseFindSurfaceInput {
  name: FindSurfaceName;
  /** Null until the underlying widget exists; the current query is re-applied when it appears. */
  engine: FindEngine | null;
  enabled: boolean;
  /** The surface's own DOM container, which also contains the find bar. */
  getRoot: () => HTMLElement | null;
  /** Surfaces whose selection is not a DOM selection (the terminal) supply their own. */
  getSelectionText?: () => string;
}

export interface UseFindSurfaceResult {
  isOpen: boolean;
  query: string;
  result: FindResult;
  open: () => void;
  close: () => void;
  setQuery: (query: string) => void;
  next: () => void;
  previous: () => void;
  inputRef: RefObject<EditingTextInputHandle | null>;
}

/**
 * The find bar's state and keyboard for one surface.
 *
 * Ownership of Cmd+F is decided by find/surface-registry, not by pane focus: several
 * panes report themselves interactive at once (see surface-registry.web.ts). Every
 * surface therefore registers itself and asks the registry whether it is the one.
 */
export function useFindSurface({
  name,
  engine,
  enabled,
  getRoot,
  getSelectionText,
}: UseFindSurfaceInput): UseFindSurfaceResult {
  const { serverId, workspaceId, tabId, host } = usePaneContext();
  const { isInteractive } = usePaneFocus();

  const [isOpen, setIsOpen] = useState(false);
  const [query, setQueryState] = useState("");
  const [result, setResult] = useState<FindResult>(EMPTY_FIND_RESULT);
  const inputRef = useRef<EditingTextInputHandle | null>(null);

  const handlerId = useMemo(
    () =>
      buildWorkspaceKeyboardHandlerId({
        name: `find-${name}`,
        serverId,
        workspaceId,
        paneId: tabId,
      }),
    [name, serverId, workspaceId, tabId],
  );

  // Read at dispatch time by callbacks that must never re-register the handler or the
  // registry entry; see use-keyboard-action-handler.ts for why re-registering is unsafe.
  const engineRef = useRef(engine);
  engineRef.current = engine;
  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;
  const queryRef = useRef(query);
  queryRef.current = query;
  const getRootRef = useRef(getRoot);
  getRootRef.current = getRoot;
  const getSelectionTextRef = useRef(getSelectionText);
  getSelectionTextRef.current = getSelectionText;
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const registrationRef = useRef({
    key: handlerId,
    getRoot: () => getRootRef.current(),
    isInteractive,
    host,
    isOpen,
  });
  registrationRef.current.key = handlerId;
  registrationRef.current.isInteractive = isInteractive;
  registrationRef.current.host = host;
  registrationRef.current.isOpen = isOpen;

  useEffect(() => {
    if (!enabled) {
      return;
    }
    return registerFindSurface(registrationRef.current);
  }, [enabled]);

  useEffect(() => {
    if (!engine) {
      setResult(EMPTY_FIND_RESULT);
      return;
    }
    const unsubscribe = engine.subscribe(setResult);
    // The query may predate the engine: typed before the widget mounted, or carried
    // across a file-pane mode switch that swapped one engine for another.
    if (isOpenRef.current && queryRef.current !== "") {
      engine.setQuery(queryRef.current);
    }
    return unsubscribe;
  }, [engine]);

  const focusInput = useCallback((text: string) => {
    const handle = inputRef.current;
    if (!handle) {
      return;
    }
    handle.focus();
    handle.replaceText(text, { start: 0, end: text.length });
  }, []);

  const open = useCallback(() => {
    const wasOpen = isOpenRef.current;
    if (!wasOpen && isWeb) {
      const active = document.activeElement;
      restoreFocusRef.current = active instanceof HTMLElement ? active : null;
    }
    const prefill = selectionPrefill(getSelectionTextRef.current, getRootRef.current());
    const nextQuery = prefill ?? queryRef.current;
    const queryChanged = nextQuery !== queryRef.current;
    queryRef.current = nextQuery;
    setQueryState(nextQuery);
    setIsOpen(true);
    // Re-running an unchanged query is not free: it moves the active match (the
    // terminal steps forward, the DOM engines re-seed from the viewport). Cmd+F on an
    // open bar is a request for the input, not for a new search.
    if (!wasOpen || queryChanged) {
      engineRef.current?.setQuery(nextQuery);
    }
    if (wasOpen) {
      focusInput(nextQuery);
    }
  }, [focusInput]);

  // A freshly opened bar has no input to focus until it has rendered.
  useEffect(() => {
    if (isOpen) {
      focusInput(queryRef.current);
    }
  }, [isOpen, focusInput]);

  const close = useCallback(() => {
    engineRef.current?.clear();
    setIsOpen(false);
    setResult(EMPTY_FIND_RESULT);
    const restore = restoreFocusRef.current;
    restoreFocusRef.current = null;
    // A surface that unmounted while the bar was open has nothing to hand focus back
    // to; leaving focus where it is beats moving it somewhere the user did not expect.
    if (restore?.isConnected) {
      restore.focus();
    }
  }, []);

  const setQuery = useCallback((nextQuery: string) => {
    queryRef.current = nextQuery;
    setQueryState(nextQuery);
    engineRef.current?.setQuery(nextQuery);
  }, []);

  const next = useCallback(() => engineRef.current?.next(), []);
  const previous = useCallback(() => engineRef.current?.previous(), []);

  useKeyboardActionHandler({
    handlerId,
    actions: ["find.open", "find.next", "find.previous"],
    enabled,
    priority: 300,
    isActive: () => resolveActiveFindSurface()?.key === handlerId,
    handle: (action) => {
      if (action.id === "find.open") {
        open();
        return true;
      }
      if (!isOpenRef.current) {
        return false;
      }
      if (action.id === "find.next") {
        next();
        return true;
      }
      if (action.id === "find.previous") {
        previous();
        return true;
      }
      return false;
    },
  });

  return { isOpen, query, result, open, close, setQuery, next, previous, inputRef };
}

/**
 * The query a fresh Cmd+F should start from, or null to keep the previous one.
 *
 * Only a single-line selection prefills: dragging across half a transcript is a copy
 * gesture, and turning it into a query would throw away what the user typed last.
 */
function selectionPrefill(
  getSelectionText: (() => string) | undefined,
  root: HTMLElement | null,
): string | null {
  const text = getSelectionText ? getSelectionText() : domSelectionText(root);
  if (text === "" || text.includes("\n") || text.trim() === "") {
    return null;
  }
  return text;
}

function domSelectionText(root: HTMLElement | null): string {
  if (!isWeb || !root) {
    return "";
  }
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return "";
  }
  const range = selection.getRangeAt(0);
  return root.contains(range.commonAncestorContainer) ? selection.toString() : "";
}

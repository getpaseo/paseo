import { useCallback, useLayoutEffect, useRef } from "react";
import { overlays, type OverlayEntry, type KeyboardInputEvent } from "./overlays";
import type { OverlayRegistration } from "./overlay-contract";
type WebOverlayKeyHandler = (event: KeyboardInputEvent) => boolean;

interface WebOverlayEntry {
  getLayer: () => number;
  getKeys: () => readonly string[];
  getScope: () => HTMLElement | null;
  getKeyHandler: () => WebOverlayKeyHandler;
  restoreFocus: HTMLElement | null;
  manageFocus: boolean;
}

const focusEntries = new WeakMap<OverlayEntry, WebOverlayEntry>();
let webOverlayListenersAttached = false;
let webOverlayFocusCheckQueued = false;

interface RemoveWebOverlayOptions {
  restoreFocus?: boolean;
}

function getTopWebOverlay(): WebOverlayEntry | undefined {
  const top = overlays.getTop();
  return top ? focusEntries.get(top) : undefined;
}

function getFocusableElements(scope: HTMLElement): HTMLElement[] {
  const selector = [
    "a[href]",
    "button:not([disabled])",
    "input:not([disabled])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    '[tabindex]:not([tabindex="-1"])',
  ].join(",");

  return Array.from(scope.querySelectorAll<HTMLElement>(selector)).filter(
    (element) =>
      element.getAttribute("aria-hidden") !== "true" &&
      !element.hasAttribute("hidden") &&
      element.getClientRects().length > 0,
  );
}

function focusFirstElement(scope: HTMLElement): void {
  const firstMenuItem = scope.querySelector<HTMLElement>(
    '[data-menu-item="true"]:not([data-menu-disabled="true"])',
  );
  const first = firstMenuItem ?? getFocusableElements(scope)[0];
  (first ?? scope).focus();
}

function handleWebOverlayFocus(event: FocusEvent): void {
  const top = getTopWebOverlay();
  const scope = top?.getScope();
  if (!top?.manageFocus || !scope || scope.contains(event.target as Node)) return;
  if (webOverlayFocusCheckQueued) return;

  // React can autofocus a child before its parent scope ref attaches. Defer
  // enforcement until the commit finishes so a newly mounted higher overlay
  // can register without the previous scope stealing the requested focus.
  webOverlayFocusCheckQueued = true;
  queueMicrotask(() => {
    webOverlayFocusCheckQueued = false;
    const currentTop = getTopWebOverlay();
    const currentScope = currentTop?.getScope();
    if (!currentTop?.manageFocus || !currentScope || currentScope.contains(document.activeElement))
      return;
    focusFirstElement(currentScope);
  });
}

/**
 * Gives the top painted overlay first refusal on a key before app-wide shortcuts run.
 * The window listener below is the fallback for keys nobody routes through the shortcut engine.
 */
function dispatchOverlayEntry(entry: WebOverlayEntry, event: KeyboardInputEvent): boolean {
  // Composition keys belong to the active text field. A modal must not turn an
  // IME candidate confirmation into an overlay shortcut before the browser has
  // committed the composed text.
  if (event.isComposing || event.key === "Process") return false;

  const top = entry;
  const scope = entry.getScope();
  if (!scope) return top.getKeyHandler()(event);

  if (top.manageFocus && event.key === "Tab") {
    const focusable = getFocusableElements(scope);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    const shouldWrapBackward = event.shiftKey && (!scope.contains(active) || active === first);
    const shouldWrapForward = !event.shiftKey && (!scope.contains(active) || active === last);
    if (shouldWrapBackward || shouldWrapForward) {
      event.preventDefault();
      event.stopPropagation();
      (shouldWrapBackward ? last : first)?.focus();
      if (!first) scope.focus();
      return true;
    }
  }

  if (!top.getKeyHandler()(event)) return false;
  event.stopPropagation();
  return true;
}

function handleWebOverlayKeyDown(event: KeyboardEvent): void {
  if (overlays.dispatch(event)) event.stopImmediatePropagation();
}

function attachWebOverlayListeners(): void {
  if (webOverlayListenersAttached) return;
  window.addEventListener("keydown", handleWebOverlayKeyDown, true);
  document.addEventListener("focusin", handleWebOverlayFocus, true);
  webOverlayListenersAttached = true;
}

function detachWebOverlayListeners(): void {
  if (!webOverlayListenersAttached || overlays.hasActive()) return;
  window.removeEventListener("keydown", handleWebOverlayKeyDown, true);
  document.removeEventListener("focusin", handleWebOverlayFocus, true);
  webOverlayListenersAttached = false;
}

function addWebOverlay(entry: WebOverlayEntry): (options?: RemoveWebOverlayOptions) => void {
  const registration: OverlayEntry = {
    getLayer: entry.getLayer,
    getKeys: entry.getKeys,
    onKeyDown: (event) => dispatchOverlayEntry(entry, event),
  };
  focusEntries.set(registration, entry);
  const remove = overlays.register(registration);
  attachWebOverlayListeners();

  const focusFrame = window.requestAnimationFrame(() => {
    const scope = entry.getScope();
    if (
      entry.manageFocus &&
      getTopWebOverlay() === entry &&
      scope &&
      !scope.contains(document.activeElement)
    ) {
      focusFirstElement(scope);
    }
  });

  return (options) => {
    window.cancelAnimationFrame(focusFrame);
    remove();
    detachWebOverlayListeners();
    if (
      entry.manageFocus &&
      options?.restoreFocus !== false &&
      entry.restoreFocus &&
      document.contains(entry.restoreFocus)
    ) {
      entry.restoreFocus.focus();
    }
  };
}

/**
 * Registers a focus scope in the same relative layer model used for painting.
 * Only the highest painted overlay receives keyboard input. By default, focus is trapped
 * there and restored to the opener when it closes; hover surfaces preserve focus instead.
 */
export function useOverlayRegistration({
  active,
  layer,
  keys,
  onKeyDown,
  manageFocus = true,
  restoreFocusRef: preferredRestoreFocusRef,
}: OverlayRegistration) {
  const scopeRef = useRef<HTMLElement | null>(null);
  const keysRef = useRef(keys);
  keysRef.current = keys;
  const layerRef = useRef(layer);
  const keyHandlerRef = useRef(onKeyDown);
  const capturedRestoreFocusRef = useRef<HTMLElement | null>(null);
  const removeEntryRef = useRef<((options?: RemoveWebOverlayOptions) => void) | null>(null);
  const detachedRemoveEntryRef = useRef<((options?: RemoveWebOverlayOptions) => void) | null>(null);
  const registeredRef = useRef(false);
  const activeRef = useRef(active);
  const wasActiveRef = useRef(false);

  activeRef.current = active;
  layerRef.current = layer;
  keyHandlerRef.current = onKeyDown;
  if (active && !wasActiveRef.current && typeof document !== "undefined") {
    const requestedRestoreTarget = preferredRestoreFocusRef?.current;
    if (requestedRestoreTarget instanceof HTMLElement) {
      capturedRestoreFocusRef.current = requestedRestoreTarget;
    } else {
      capturedRestoreFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
  }
  wasActiveRef.current = active;

  const syncRegistration = useCallback(() => {
    const shouldRegister =
      activeRef.current && typeof window !== "undefined" && typeof document !== "undefined";
    if (!shouldRegister) {
      const shouldRestoreFocus = !activeRef.current;
      if (registeredRef.current || shouldRestoreFocus) {
        removeEntryRef.current?.({ restoreFocus: shouldRestoreFocus });
      }
      registeredRef.current = false;
      if (shouldRestoreFocus) {
        removeEntryRef.current = null;
        detachedRemoveEntryRef.current = null;
      }
      return;
    }
    if (registeredRef.current) return;

    detachedRemoveEntryRef.current = null;
    const entry: WebOverlayEntry = {
      getLayer: () => layerRef.current,
      getKeys: () => keysRef.current,
      getScope: () => scopeRef.current,
      getKeyHandler: () => keyHandlerRef.current,
      restoreFocus: capturedRestoreFocusRef.current,
      manageFocus,
    };
    removeEntryRef.current = addWebOverlay(entry);
    registeredRef.current = true;
  }, [manageFocus]);

  const setScope = useCallback(
    (node: unknown) => {
      scopeRef.current =
        typeof HTMLElement !== "undefined" && node instanceof HTMLElement ? node : null;
      if (!scopeRef.current && activeRef.current) {
        const removeEntry = removeEntryRef.current;
        removeEntry?.({ restoreFocus: false });
        detachedRemoveEntryRef.current = removeEntry;
        removeEntryRef.current = null;
        registeredRef.current = false;
        return;
      }
      // Host refs attach before descendant layout effects and autofocus. Register
      // here so the previous overlay cannot redirect that pending focus.
      syncRegistration();
    },
    [syncRegistration],
  );

  useLayoutEffect(() => {
    syncRegistration();
    return () => {
      const removeEntry = removeEntryRef.current ?? detachedRemoveEntryRef.current;
      removeEntry?.();
      removeEntryRef.current = null;
      detachedRemoveEntryRef.current = null;
      registeredRef.current = false;
    };
  }, [active, syncRegistration]);

  return setScope;
}

import { useLayoutEffect, useMemo, useRef } from "react";
import type {
  PressDragOptions,
  PressDragSelection,
  PressDragSnapshot,
  PressDragTarget,
} from "./press-drag-select-context";

const interactiveSelector =
  'button, a, input, textarea, select, [role="button"], [role="menuitem"], [contenteditable="true"]';

/** The browser can deliver click after the selected row (and its root) has unmounted. */
function suppressGestureClick(doc: Document, pointerId: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cleanup = () => {
    clearTimeout(timer);
    doc.removeEventListener("click", click, true);
    doc.removeEventListener("pointerup", release, true);
    doc.removeEventListener("pointercancel", release, true);
    doc.removeEventListener("pointerdown", cleanup, true);
    doc.defaultView?.removeEventListener("blur", cleanup);
  };
  const click = (event: MouseEvent) => {
    if (event.detail === 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    cleanup();
  };
  const release = (event: PointerEvent) => {
    if (event.pointerId === pointerId) timer = setTimeout(cleanup, 0);
  };
  doc.addEventListener("click", click, true);
  doc.addEventListener("pointerup", release, true);
  doc.addEventListener("pointercancel", release, true);
  doc.addEventListener("pointerdown", cleanup, true);
  doc.defaultView?.addEventListener("blur", cleanup);
}

function createSelection(getOptions: () => PressDragOptions) {
  const targets = new Map<HTMLElement, () => PressDragTarget>();
  const surfaces = new Set<HTMLElement>();
  const backdrops = new Set<HTMLElement>();
  const listeners = new Set<() => void>();
  let snapshot: PressDragSnapshot = { dragging: false, target: null };
  let anchor: HTMLElement | null = null;
  let pointerId: number | null = null;
  let beganOpen = false;
  let observedOpen = false;
  let doc: Document | null = null;

  const publish = (dragging: boolean, target: unknown = null) => {
    if (snapshot.dragging === dragging && snapshot.target === target) return;
    snapshot = { dragging, target };
    listeners.forEach((listener) => listener());
  };
  const hit = (event: PointerEvent) => doc?.elementFromPoint(event.clientX, event.clientY) ?? null;
  const targetAt = (node: Element | null) => {
    const visibleSurface = [...surfaces].some((surface) => {
      if (!node || !surface.contains(node)) return false;
      const style = getComputedStyle(surface);
      return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0;
    });
    if (!visibleSurface) return null;
    if (node?.closest('[aria-disabled="true"], :disabled')) return null;
    let interactive: Element | null = null;
    for (let current = node; current; current = current.parentElement) {
      if (current instanceof HTMLElement && targets.has(current)) {
        const primary = current.matches(interactiveSelector)
          ? current
          : current.querySelector(interactiveSelector);
        // RNW disabled Pressables let their wrapper receive hits in row padding.
        if (primary?.matches('[aria-disabled="true"], :disabled')) return null;
        // Custom renderOption wrappers may contain one primary Pressable. Nested
        // controls inside that Pressable still belong to their own actions.
        if (interactive && (current.matches(interactiveSelector) || primary !== interactive))
          return null;
        return current;
      }
      if (!interactive && current.matches(interactiveSelector)) interactive = current;
    }
    return null;
  };
  const inAnchor = (event: PointerEvent) => {
    const rect = anchor?.getBoundingClientRect();
    return (
      rect &&
      event.clientX >= rect.left &&
      event.clientX < rect.right &&
      event.clientY >= rect.top &&
      event.clientY < rect.bottom
    );
  };
  const stop = () => {
    doc?.removeEventListener("pointermove", move, true);
    doc?.removeEventListener("pointerup", release, true);
    doc?.removeEventListener("pointercancel", cancel, true);
    doc?.defaultView?.removeEventListener("blur", cancel);
    pointerId = null;
    publish(false);
  };
  const cancel = () => {
    stop();
  };
  const move = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    if (!(event.buttons & 1)) {
      stop();
      return;
    }
    const node = beganOpen || inAnchor(event) ? null : targetAt(hit(event));
    publish(true, node && !targets.get(node)?.().disabled ? node : null);
  };
  const release = (event: PointerEvent) => {
    if (event.pointerId !== pointerId || event.button !== 0) return;
    const node = hit(event);
    const target = inAnchor(event) ? null : targetAt(node);
    const action = target ? targets.get(target)?.() : undefined;
    const inside =
      inAnchor(event) || [...surfaces].some((surface) => node && surface.contains(node));
    const select = !beganOpen && getOptions().open;
    stop();
    if (!select) return;
    if (action && !action.disabled) action.onSelect();
    else if (!inside) getOptions().onOpenChange(false);
  };
  const down = (event: PointerEvent) => {
    const options = getOptions();
    if (
      !options.enabled ||
      event.pointerType !== "mouse" ||
      event.button !== 0 ||
      event.ctrlKey ||
      !event.isPrimary
    )
      return;
    const node = event.target instanceof Element ? event.target : null;
    if (node?.closest('[aria-disabled="true"], :disabled')) return;
    if (
      anchor &&
      [...anchor.querySelectorAll('[aria-disabled="true"], :disabled')].some((disabled) => {
        const rect = disabled.getBoundingClientRect();
        return (
          event.clientX >= rect.left &&
          event.clientX < rect.right &&
          event.clientY >= rect.top &&
          event.clientY < rect.bottom
        );
      })
    )
      return;
    // A floating surface can overlap its opener; its rows retain their own presses.
    if ([...surfaces].some((surface) => node && surface.contains(node))) return;
    event.preventDefault();
    event.stopPropagation();
    stop();
    doc = anchor?.ownerDocument ?? null;
    if (!doc) return;
    pointerId = event.pointerId;
    beganOpen = options.open;
    observedOpen = options.open;
    suppressGestureClick(doc, pointerId);
    doc.addEventListener("pointermove", move, true);
    doc.addEventListener("pointerup", release, true);
    doc.addEventListener("pointercancel", cancel, true);
    doc.defaultView?.addEventListener("blur", cancel);
    publish(!beganOpen);
    options.onOpenChange(!options.open);
  };
  const openAnchorDown = (event: PointerEvent) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    // Only our own backdrop may stand in for the covered trigger. A higher
    // modal at the same coordinates must keep its pointer events.
    if (!anchor?.contains(target) && !backdrops.has(target)) return;
    if (getOptions().open && inAnchor(event)) down(event);
  };
  const selection: PressDragSelection = {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    registerTarget: (node, getTarget) => {
      if (!(node instanceof HTMLElement)) return () => {};
      targets.set(node, getTarget);
      return () => {
        targets.delete(node);
      };
    },
    registerSurface: (node, kind) => {
      if (!(node instanceof HTMLElement)) return () => {};
      const registry = kind === "backdrop" ? backdrops : surfaces;
      registry.add(node);
      return () => {
        registry.delete(node);
      };
    },
  };
  const sync = () => {
    const options = getOptions();
    const next =
      options.enabled && options.anchorRef.current instanceof HTMLElement
        ? options.anchorRef.current
        : null;
    if (anchor !== next) {
      stop();
      anchor?.removeEventListener("pointerdown", down, true);
      anchor?.ownerDocument.removeEventListener("pointerdown", openAnchorDown, true);
      anchor = next;
      anchor?.addEventListener("pointerdown", down, true);
    }
    anchor?.ownerDocument.removeEventListener("pointerdown", openAnchorDown, true);
    if (options.open) anchor?.ownerDocument.addEventListener("pointerdown", openAnchorDown, true);
    if (pointerId !== null && !beganOpen && observedOpen && !options.open) stop();
    observedOpen = options.open;
  };
  const dispose = () => {
    stop();
    anchor?.removeEventListener("pointerdown", down, true);
    anchor?.ownerDocument.removeEventListener("pointerdown", openAnchorDown, true);
    anchor = null;
  };
  return { selection, sync, dispose };
}

export function usePressDragSelect(options: PressDragOptions): PressDragSelection {
  const latest = useRef(options);
  latest.current = options;
  const controller = useMemo(() => createSelection(() => latest.current), []);
  // Ref targets can change without their RefObject changing (custom trigger variants).
  useLayoutEffect(() => controller.sync());
  useLayoutEffect(() => () => controller.dispose(), [controller]);
  return controller.selection;
}

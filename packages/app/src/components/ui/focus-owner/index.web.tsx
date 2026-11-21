import { useCallback, useEffect, useRef, type SyntheticEvent } from "react";
import { FocusOwnerContext, type FocusOwnerScopeProps } from "./context";

export { useFocusOwner, type FocusOwner, type FocusOwnerScopeProps } from "./context";

const claimedEvents = new WeakSet<Event>();

const contentsStyle = { display: "contents" } as const;

const CLAIMED_EVENTS = ["pointerdown", "focusin"] as const;

/**
 * Web: a pointer press or focus move in the scope calls its owner, heard on two paths.
 *
 * - React's tree, through capture handlers: covers `createPortal` overlays drawn at the overlay
 *   root (menus, comboboxes, tooltips). `@gorhom/portal` content re-opens the scope on its far
 *   side (`Portal`, the bottom sheet).
 * - The DOM, through listeners on the scope's own node: React drops the events it would dispatch
 *   while it commits, and that is when a closing picker hands focus back to its trigger and the
 *   composer. Those focus moves land in the scope's own nodes, so the DOM hears them.
 *
 * The scope is a `display: contents` element, so it adds no box.
 */
export function FocusOwnerScope({ owner, children }: FocusOwnerScopeProps) {
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const nodeRef = useRef<HTMLDivElement>(null);
  const claimNative = useCallback((event: Event) => {
    claimedEvents.add(event);
    ownerRef.current?.();
  }, []);
  const claim = useCallback(
    (event: SyntheticEvent) => claimNative(event.nativeEvent),
    [claimNative],
  );
  const hasOwner = owner !== null;
  useEffect(() => {
    const node = nodeRef.current;
    if (!node) return undefined;
    for (const type of CLAIMED_EVENTS) node.addEventListener(type, claimNative, true);
    return () => {
      for (const type of CLAIMED_EVENTS) node.removeEventListener(type, claimNative, true);
    };
  }, [claimNative, hasOwner]);
  if (!owner) return children;
  return (
    <FocusOwnerContext.Provider value={owner}>
      <div ref={nodeRef} style={contentsStyle} onPointerDownCapture={claim} onFocusCapture={claim}>
        {children}
      </div>
    </FocusOwnerContext.Provider>
  );
}

/**
 * Whether a focus owner heard this `pointerdown` or `focusin`. Owners hear events at React's
 * root and at their own node, so read this from a listener that runs after both: `document`,
 * bubble phase.
 */
export function wasClaimedByFocusOwner(event: Event): boolean {
  return claimedEvents.has(event);
}

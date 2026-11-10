import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type PropsWithChildren,
  type ReactElement,
} from "react";

interface OverlayDismissal {
  register(close: () => void): () => void;
  dismissAll(): Promise<void>;
}

interface OpenOverlay {
  close: () => void;
}

function createOverlayDismissal(): OverlayDismissal {
  const open = new Set<OpenOverlay>();
  const closing = new Map<OpenOverlay, () => void>();
  return {
    register(close) {
      const overlay = { close };
      open.add(overlay);
      return () => {
        open.delete(overlay);
        closing.get(overlay)?.();
        closing.delete(overlay);
      };
    },
    dismissAll() {
      // An overlay is gone in the commit that unregisters it. That commit can also move focus, such
      // as a web modal handing it back to the button that opened it.
      return Promise.all(
        [...open].map(
          (overlay) =>
            new Promise<void>((gone) => {
              closing.set(overlay, gone);
              overlay.close();
            }),
        ),
      ).then(() => undefined);
    },
  };
}

const OverlayDismissalContext = createContext<OverlayDismissal | null>(null);

/**
 * A region that can close the sheets, menus and popovers opened from inside it. The composer is
 * one: putting the cursor in it closes whatever it opened over itself. A scope inside another joins
 * it, so a host widens the region by opening a scope around the composer and its neighbours.
 */
export function OverlayDismissalScope({ children }: PropsWithChildren): ReactElement {
  const enclosing = useContext(OverlayDismissalContext);
  const [own] = useState(createOverlayDismissal);
  return (
    <OverlayDismissalContext.Provider value={enclosing ?? own}>
      {children}
    </OverlayDismissalContext.Provider>
  );
}

/** While `open`, the enclosing scope, if any, can close this overlay through `close`. */
export function useDismissibleOverlay(open: boolean, close: () => void): void {
  const scope = useContext(OverlayDismissalContext);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!scope || !open) return;
    return scope.register(() => closeRef.current());
  }, [scope, open]);
}

/**
 * Closes every overlay open in the enclosing scope, and resolves once they are gone. Outside a
 * scope there is nothing to close. A registered `close` must close the overlay.
 */
export function useDismissOverlays(): () => Promise<void> {
  const scope = useContext(OverlayDismissalContext);
  return useCallback(() => scope?.dismissAll() ?? Promise.resolve(), [scope]);
}

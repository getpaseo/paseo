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
  dismissAll(): void;
}

function createOverlayDismissal(): OverlayDismissal {
  const closers = new Set<() => void>();
  return {
    register(close) {
      closers.add(close);
      return () => {
        closers.delete(close);
      };
    },
    dismissAll() {
      for (const close of closers) close();
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

/** Closes every overlay open in the enclosing scope; nothing outside one. */
export function useDismissOverlays(): () => void {
  const scope = useContext(OverlayDismissalContext);
  return useCallback(() => scope?.dismissAll(), [scope]);
}

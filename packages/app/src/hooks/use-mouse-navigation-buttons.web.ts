import { useEffect, useRef } from "react";
import { usePathname, useRouter, type Href } from "expo-router";
import { getIsElectron } from "@/constants/platform";
import { createViewHistoryTracker, shouldRecordPathname } from "@/navigation/view-history-tracker";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { parseHostWorkspaceRouteFromPathname } from "@/utils/host-routes";

// Mouse button 3 is "back" (X1), button 4 is "forward" (X2). Chromium navigates
// browser history on these natively, but in-app navigation mostly uses
// dismissTo()/replace(), so browser history has no entries to walk and the
// default no-ops. The app therefore keeps its own view history and suppresses
// the Chromium default: preventDefault() on pointerdown cancels it (on
// mousedown it does not) and also suppresses the compat mouse events for the
// press — harmless, nothing in the app reads button 3/4 mouse events.
//
// Electron-only: in a plain browser the default navigation already works for
// pushed routes and intercepting the buttons would change browser-back
// semantics.
const BACK_BUTTON = 3;
const FORWARD_BUTTON = 4;

// Section redirects (e.g. /settings -> /settings/general) replace themselves
// within a tick. Wait for a pathname to actually rest before recording it so
// back never lands on a route that flings you forward again.
const SETTLE_MS = 80;

export function useMouseNavigationButtons(): void {
  const pathname = usePathname();
  const router = useRouter();
  const trackerRef = useRef(createViewHistoryTracker());
  const expectedNavigationRef = useRef<string | null>(null);
  const routerRef = useRef(router);
  routerRef.current = router;

  useEffect(() => {
    // Back/forward navigation resolves to this pathname next; the tracker
    // already moved its index, so don't re-record it as a fresh view — that
    // would truncate the forward stack.
    if (expectedNavigationRef.current === pathname) {
      expectedNavigationRef.current = null;
      return;
    }
    expectedNavigationRef.current = null;
    if (!shouldRecordPathname(pathname)) {
      return;
    }
    const timer = setTimeout(() => trackerRef.current.record(pathname), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [pathname]);

  useEffect(() => {
    if (!getIsElectron()) {
      return () => {};
    }

    const navigateTo = (target: string | null) => {
      if (!target) return;
      expectedNavigationRef.current = target;
      const workspace = parseHostWorkspaceRouteFromPathname(target);
      if (workspace) {
        navigateToWorkspace(workspace);
      } else {
        routerRef.current.push(target as Href);
      }
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button === BACK_BUTTON || event.button === FORWARD_BUTTON) {
        event.preventDefault();
      }
    };
    const handlePointerUp = (event: PointerEvent) => {
      if (event.button === BACK_BUTTON) {
        event.preventDefault();
        navigateTo(trackerRef.current.goBack());
      } else if (event.button === FORWARD_BUTTON) {
        event.preventDefault();
        navigateTo(trackerRef.current.goForward());
      }
    };
    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("pointerup", handlePointerUp, true);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("pointerup", handlePointerUp, true);
    };
  }, []);
}

import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { SidebarCallout, type SidebarCalloutProps } from "@/components/sidebar-callout";
import { useStableEvent } from "@/hooks/use-stable-event";
import {
  clearSidebarCallouts,
  createSidebarCalloutState,
  dismissSidebarCallout,
  loadDismissedCalloutKeys,
  parseDismissedCalloutKeys,
  selectActiveSidebarCallout,
  serializeDismissedCalloutKeys,
  showSidebarCallout,
  type SidebarCalloutEntry,
  type SidebarCalloutOptions,
  type SidebarCalloutState,
  unregisterSidebarCallout,
} from "./sidebar-callout-state";

export type { SidebarCalloutOptions } from "./sidebar-callout-state";

export interface SidebarCalloutsApi {
  show: (callout: SidebarCalloutOptions) => () => void;
  dismiss: (id: string) => void;
  clear: () => void;
}

const DISMISSED_CALLOUTS_STORAGE_KEY = "@paseo:sidebar-callout-dismissals";

const SidebarCalloutApiContext = createContext<SidebarCalloutsApi | null>(null);
const SidebarCalloutStateContext = createContext<SidebarCalloutEntry | null>(null);

function persistDismissedCalloutKeys(keys: ReadonlySet<string>): void {
  void AsyncStorage.setItem(
    DISMISSED_CALLOUTS_STORAGE_KEY,
    serializeDismissedCalloutKeys(keys),
  ).catch((error) => {
    console.error("[SidebarCallouts] Failed to persist dismissed callouts", error);
  });
}

export function SidebarCalloutProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SidebarCalloutState>(createSidebarCalloutState);
  const stateRef = useRef<SidebarCalloutState>(state);

  function commitState(next: SidebarCalloutState): void {
    stateRef.current = next;
    setState(next);
  }

  useEffect(() => {
    let mounted = true;

    async function loadDismissedKeys(): Promise<void> {
      let dismissedKeys: ReadonlySet<string>;
      try {
        const value = await AsyncStorage.getItem(DISMISSED_CALLOUTS_STORAGE_KEY);
        dismissedKeys = parseDismissedCalloutKeys(value);
      } catch (error) {
        console.error("[SidebarCallouts] Failed to load dismissed callouts", error);
        dismissedKeys = stateRef.current.dismissedKeys;
      }

      if (mounted) {
        commitState(loadDismissedCalloutKeys(stateRef.current, dismissedKeys));
      }
    }

    void loadDismissedKeys();

    return () => {
      mounted = false;
    };
  }, []);

  const show = useStableEvent((callout: SidebarCalloutOptions) => {
    const result = showSidebarCallout(stateRef.current, callout);
    commitState(result.state);

    return () => {
      commitState(
        unregisterSidebarCallout(stateRef.current, { id: callout.id, token: result.token }),
      );
    };
  });

  const dismiss = useStableEvent((id: string) => {
    const result = dismissSidebarCallout(stateRef.current, id);
    commitState(result.state);

    if (result.dismissalKey) {
      persistDismissedCalloutKeys(result.state.dismissedKeys);
    }

    result.dismissedCallout?.onDismiss?.();
  });

  const clear = useStableEvent(() => {
    commitState(clearSidebarCallouts(stateRef.current));
  });

  const api = useMemo<SidebarCalloutsApi>(() => ({ show, dismiss, clear }), [clear, dismiss, show]);
  const activeCallout = useMemo(() => selectActiveSidebarCallout(state), [state]);

  return (
    <SidebarCalloutApiContext.Provider value={api}>
      <SidebarCalloutStateContext.Provider value={activeCallout}>
        {children}
      </SidebarCalloutStateContext.Provider>
    </SidebarCalloutApiContext.Provider>
  );
}

export function useSidebarCallouts(): SidebarCalloutsApi {
  const api = useContext(SidebarCalloutApiContext);
  if (!api) {
    throw new Error("useSidebarCallouts must be used within SidebarCalloutProvider");
  }
  return api;
}

export function useActiveSidebarCallout(): SidebarCalloutEntry | null {
  return useContext(SidebarCalloutStateContext);
}

export function SidebarCalloutViewport() {
  const activeCallout = useActiveSidebarCallout();
  const api = useSidebarCallouts();
  if (!activeCallout) {
    return null;
  }

  const cardProps: SidebarCalloutProps = {
    title: activeCallout.title,
    description: activeCallout.description,
    icon: activeCallout.icon,
    variant: activeCallout.variant,
    actions: activeCallout.actions,
    onDismiss:
      activeCallout.dismissible === false ? undefined : () => api.dismiss(activeCallout.id),
    testID: activeCallout.testID,
  };

  return <SidebarCallout {...cardProps} />;
}

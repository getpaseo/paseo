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
import {
  SidebarCallout,
  type SidebarCalloutAction,
  type SidebarCalloutProps,
  type SidebarCalloutVariant,
} from "@/components/sidebar-callout";
import { useStableEvent } from "@/hooks/use-stable-event";

export interface SidebarCalloutOptions {
  id: string;
  dismissalKey?: string;
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  variant?: SidebarCalloutVariant;
  actions?: readonly SidebarCalloutAction[];
  dismissible?: boolean;
  priority?: number;
  onDismiss?: () => void;
  testID?: string;
}

export interface SidebarCalloutsApi {
  show: (callout: SidebarCalloutOptions) => () => void;
  dismiss: (id: string) => void;
  clear: () => void;
}

type SidebarCalloutEntry = SidebarCalloutOptions & {
  order: number;
  priority: number;
  token: number;
};

const DISMISSED_CALLOUTS_STORAGE_KEY = "@paseo:sidebar-callout-dismissals";

const SidebarCalloutApiContext = createContext<SidebarCalloutsApi | null>(null);
const SidebarCalloutStateContext = createContext<SidebarCalloutEntry | null>(null);

function normalizeDismissalKey(key: string | null | undefined): string | null {
  const trimmed = key?.trim();
  return trimmed ? trimmed : null;
}

function parseDismissedCalloutKeys(value: string | null): Set<string> {
  if (!value) {
    return new Set();
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return new Set();
    }
    return new Set(parsed.filter((entry): entry is string => typeof entry === "string"));
  } catch {
    return new Set();
  }
}

function persistDismissedCalloutKeys(keys: ReadonlySet<string>): void {
  void AsyncStorage.setItem(DISMISSED_CALLOUTS_STORAGE_KEY, JSON.stringify([...keys])).catch(
    (error) => {
      console.error("[SidebarCallouts] Failed to persist dismissed callouts", error);
    },
  );
}

function selectActiveCallout(input: {
  callouts: readonly SidebarCalloutEntry[];
  dismissedKeys: ReadonlySet<string>;
  dismissalStorageLoaded: boolean;
}): SidebarCalloutEntry | null {
  const visibleCallouts = input.callouts.filter((entry) => {
    const dismissalKey = normalizeDismissalKey(entry.dismissalKey);
    if (!dismissalKey) {
      return true;
    }
    return input.dismissalStorageLoaded && !input.dismissedKeys.has(dismissalKey);
  });

  if (visibleCallouts.length === 0) {
    return null;
  }
  return (
    [...visibleCallouts].sort((a, b) => b.priority - a.priority || a.order - b.order)[0] ?? null
  );
}

export function SidebarCalloutProvider({ children }: { children: ReactNode }) {
  const [callouts, setCallouts] = useState<SidebarCalloutEntry[]>([]);
  const [dismissedKeys, setDismissedKeys] = useState<Set<string>>(new Set());
  const [dismissalStorageLoaded, setDismissalStorageLoaded] = useState(false);
  const calloutsRef = useRef<SidebarCalloutEntry[]>([]);
  const dismissedKeysRef = useRef<Set<string>>(new Set());
  const orderRef = useRef(0);
  const tokenRef = useRef(0);

  useEffect(() => {
    let mounted = true;
    void AsyncStorage.getItem(DISMISSED_CALLOUTS_STORAGE_KEY)
      .then((value) => {
        if (!mounted) {
          return;
        }
        const nextKeys = parseDismissedCalloutKeys(value);
        dismissedKeysRef.current = nextKeys;
        setDismissedKeys(nextKeys);
        return;
      })
      .catch((error) => {
        console.error("[SidebarCallouts] Failed to load dismissed callouts", error);
      })
      .finally(() => {
        if (mounted) {
          setDismissalStorageLoaded(true);
        }
      });

    return () => {
      mounted = false;
    };
  }, []);

  const show = useStableEvent((callout: SidebarCalloutOptions) => {
    tokenRef.current += 1;
    const token = tokenRef.current;
    const current = calloutsRef.current;
    const existing = current.find((entry) => entry.id === callout.id);
    const nextEntry: SidebarCalloutEntry = {
      ...callout,
      priority: callout.priority ?? 0,
      order: existing?.order ?? ++orderRef.current,
      token,
    };
    const next = existing
      ? current.map((entry) => (entry.id === callout.id ? nextEntry : entry))
      : [...current, nextEntry];

    calloutsRef.current = next;
    setCallouts(next);

    return () => {
      const updated = calloutsRef.current.filter(
        (entry) => entry.id !== callout.id || entry.token !== token,
      );
      calloutsRef.current = updated;
      setCallouts(updated);
    };
  });

  const dismiss = useStableEvent((id: string) => {
    const dismissed = calloutsRef.current.find((entry) => entry.id === id) ?? null;
    const next = calloutsRef.current.filter((entry) => entry.id !== id);
    calloutsRef.current = next;
    setCallouts(next);

    const dismissalKey = normalizeDismissalKey(dismissed?.dismissalKey);
    if (dismissalKey) {
      const nextKeys = new Set(dismissedKeysRef.current);
      nextKeys.add(dismissalKey);
      dismissedKeysRef.current = nextKeys;
      setDismissedKeys(nextKeys);
      persistDismissedCalloutKeys(nextKeys);
    }

    dismissed?.onDismiss?.();
  });

  const clear = useStableEvent(() => {
    calloutsRef.current = [];
    setCallouts([]);
  });

  const api = useMemo<SidebarCalloutsApi>(() => ({ show, dismiss, clear }), [clear, dismiss, show]);
  const activeCallout = useMemo(
    () => selectActiveCallout({ callouts, dismissedKeys, dismissalStorageLoaded }),
    [callouts, dismissedKeys, dismissalStorageLoaded],
  );

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

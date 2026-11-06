// Test stub for expo-router. The sidebar module graph pulls it in through the
// navigation-active-workspace store and the archive-redirect util; browser tests only need the
// hooks to exist and the router to be a no-op — a real navigation never happens in a test.
export const useLocalSearchParams = () => ({});

export const usePathname = () => "/";

export const router = {
  push: () => undefined,
  replace: () => undefined,
  back: () => undefined,
  navigate: () => undefined,
  canDismiss: () => false,
  dismiss: () => undefined,
  dismissAll: () => undefined,
};

export const useRouter = () => router;

export function Link(): null {
  return null;
}

export const Redirect = (): null => null;
export const Slot = (): null => null;
export const Unmatched = (): null => null;
export const Stack = { Screen: (): null => null };
export const Tabs = { Screen: (): null => null };

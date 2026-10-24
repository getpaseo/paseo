import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import type { ScreenHeaderActionsProps, ScreenHeaderButtonProps } from "@getpaseo/plugin/client/ui";
import { usePluginRuntimeContextBridge } from "@getpaseo/plugin/client/host";
import {
  createContext,
  useContext,
  useId,
  useLayoutEffect,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { withUnistyles } from "react-native-unistyles";
import { HeaderToggleButton } from "@/components/headers/header-toggle-button";
import {
  iconButtonChromeGlyphSize,
  mutedIconColorMapping,
} from "@/components/ui/icon-button-chrome";
import { ToastApiProvider, useToast as useAppToast } from "@/contexts/toast-api-context";
import type { ShortcutKey } from "@/utils/format-shortcut";
import { Icon } from "../icons";

/**
 * What a plugin screen puts in its header. Each mounted `ScreenHeaderActions` holds an entry;
 * the last one mounted is shown. `present` changes only when that flips, so the screen can
 * decide whether to draw the actions island without re-rendering on every content update.
 */
export interface ScreenHeaderSlot {
  set(owner: string, content: ReactNode): void;
  remove(owner: string): void;
  subscribe(listener: () => void): () => void;
  content(): ReactNode;
  present(): boolean;
}

export function createScreenHeaderSlot(): ScreenHeaderSlot {
  const entries = new Map<string, ReactNode>();
  const listeners = new Set<() => void>();
  let current: ReactNode = null;
  const publish = () => {
    current = entries.size > 0 ? Array.from(entries.values()).at(-1) : null;
    for (const listener of listeners) listener();
  };
  return {
    set(owner, content) {
      entries.set(owner, content);
      publish();
    },
    remove(owner) {
      if (entries.delete(owner)) publish();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    content: () => current,
    present: () => entries.size > 0,
  };
}

const ScreenHeaderSlotContext = createContext<ScreenHeaderSlot | null>(null);

/** Given to a plugin screen's tree by the screen route. */
export const ScreenHeaderSlotProvider = ScreenHeaderSlotContext.Provider;

/** True while the screen has header actions to show. */
export function useScreenHeaderActionsPresent(slot: ScreenHeaderSlot): boolean {
  return useSyncExternalStore(slot.subscribe, slot.present, slot.present);
}

/** Draws the screen's header actions where the screen route puts them. */
export function ScreenHeaderActionsOutlet({ slot }: { slot: ScreenHeaderSlot }) {
  return <>{useSyncExternalStore(slot.subscribe, slot.content, slot.content)}</>;
}

/**
 * The plugin's half: hands the header its children, wrapped in the plugin's runtime contexts,
 * since the header draws them outside the screen's tree.
 */
export function ScreenHeaderActions({ children }: ScreenHeaderActionsProps) {
  const slot = useContext(ScreenHeaderSlotContext);
  return slot ? <ScreenHeaderActionsEntry slot={slot}>{children}</ScreenHeaderActionsEntry> : null;
}

function ScreenHeaderActionsEntry({
  slot,
  children,
}: {
  slot: ScreenHeaderSlot;
  children: ReactNode;
}) {
  const owner = useId();
  const queryClient = useQueryClient();
  const toast = useAppToast();
  const bridgePluginRuntime = usePluginRuntimeContextBridge();
  const content = (
    <QueryClientProvider client={queryClient}>
      <ToastApiProvider api={toast}>{bridgePluginRuntime(children)}</ToastApiProvider>
    </QueryClientProvider>
  );
  // Every render: the children carry the screen's latest state.
  useLayoutEffect(() => {
    slot.set(owner, content);
  });
  useLayoutEffect(() => () => slot.remove(owner), [slot, owner]);
  return null;
}

const NO_SHORTCUT: ShortcutKey[] = [];
const ThemedIcon = withUnistyles(Icon);

export function ScreenHeaderButton({
  icon,
  label,
  onPress,
  active = false,
  disabled = false,
  testID,
}: ScreenHeaderButtonProps) {
  return (
    <HeaderToggleButton
      onPress={onPress}
      active={active}
      disabled={disabled}
      tooltipLabel={label}
      tooltipKeys={NO_SHORTCUT}
      tooltipSide="bottom"
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <ThemedIcon
        icon={icon}
        size={iconButtonChromeGlyphSize("large")}
        uniProps={mutedIconColorMapping}
      />
    </HeaderToggleButton>
  );
}

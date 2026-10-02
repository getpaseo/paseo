import { useCallback, useMemo } from "react";
import { useAppSettings } from "@/hooks/use-settings";
import { useUsageHostId } from "./hosts";
import { useUsageHostReports } from "./queries";
import {
  isUsagePinned,
  setUsageDisplayAs,
  toggleUsagePin,
  type UsageDisplayAs,
  type UsagePin,
  type UsagePreferences,
} from "./preferences";

/** What usage views need from the preferences: how to read percents, and the pins. */
export interface UsageDisplay {
  displayAs: UsageDisplayAs;
  setDisplayAs: (displayAs: UsageDisplayAs) => void;
  isPinned: (pin: UsagePin) => boolean;
  togglePin: (pin: UsagePin) => void;
}

/** The device's usage preferences, and the commands that change them. */
export function useUsagePreferences(serverId?: string): {
  preferences: UsagePreferences;
  display: UsageDisplay;
} {
  const { settings, updateSettings } = useAppSettings();
  const preferences = settings.usage;
  const defaultServerId = useUsageHostId();
  const reports = useUsageHostReports(serverId ?? defaultServerId);
  const setDisplayAs = useCallback(
    (displayAs: UsageDisplayAs) => {
      void updateSettings((current) => ({ usage: setUsageDisplayAs(current.usage, displayAs) }));
    },
    [updateSettings],
  );
  const togglePin = useCallback(
    (pin: UsagePin) => {
      void updateSettings((current) => ({ usage: toggleUsagePin(current.usage, pin, reports) }));
    },
    [updateSettings, reports],
  );
  const display = useMemo<UsageDisplay>(
    () => ({
      displayAs: preferences.displayAs,
      setDisplayAs,
      isPinned: (pin) => isUsagePinned(preferences, pin, reports),
      togglePin,
    }),
    [preferences, reports, setDisplayAs, togglePin],
  );
  return { preferences, display };
}

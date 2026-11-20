import { useCallback, useMemo } from "react";
import { useAppSettings } from "@/hooks/use-settings";
import {
  arrangeUsageCards,
  arrangeUsageReports,
  isUsageCardOff,
  isUsagePinned,
  setUsageCardOn,
  setUsageDisplayAs,
  toggleUsagePin,
  type UsageCardDrop,
  type UsageDisplayAs,
  type UsagePin,
  type UsagePreferences,
} from "./preferences";
import type { UsageReportEntry } from "./types";

/** What usage views need from the preferences: how to read percents, the pins, and the cards. */
export interface UsageDisplay {
  displayAs: UsageDisplayAs;
  setDisplayAs: (displayAs: UsageDisplayAs) => void;
  isPinned: (pin: UsagePin) => boolean;
  togglePin: (pin: UsagePin) => void;
  /** Reports in the order their cards show. */
  arrange: (reports: readonly UsageReportEntry[]) => UsageReportEntry[];
  /** Saves the order of the shown cards after the user drops one. */
  arrangeCards: (drop: UsageCardDrop) => void;
  isCardOn: (reportId: string) => boolean;
  setCardOn: (reportId: string, on: boolean) => void;
}

interface UsagePreferencesState {
  preferences: UsagePreferences;
  display: UsageDisplay;
}

/** The device's usage preferences, with pins resolved against the given reports. */
export function useUsageDisplay(reports: readonly UsageReportEntry[]): UsagePreferencesState {
  const { settings, updateSettings } = useAppSettings();
  const preferences = settings.usage;
  const setDisplayAs = useCallback(
    (displayAs: UsageDisplayAs) => {
      void updateSettings((current) => ({ usage: setUsageDisplayAs(current.usage, displayAs) }));
    },
    [updateSettings],
  );
  const togglePin = useCallback(
    (pin: UsagePin) => {
      void updateSettings((current) => ({
        usage: toggleUsagePin({ preferences: current.usage, pin, reports }),
      }));
    },
    [updateSettings, reports],
  );
  const arrangeCards = useCallback(
    (drop: UsageCardDrop) => {
      void updateSettings((current) => ({ usage: arrangeUsageCards(current.usage, drop) }));
    },
    [updateSettings],
  );
  const setCardOn = useCallback(
    (reportId: string, on: boolean) => {
      void updateSettings((current) => ({ usage: setUsageCardOn(current.usage, reportId, on) }));
    },
    [updateSettings],
  );
  const display = useMemo<UsageDisplay>(
    () => ({
      displayAs: preferences.displayAs,
      setDisplayAs,
      isPinned: (pin) => isUsagePinned(preferences, pin, reports),
      togglePin,
      arrange: (shown) => arrangeUsageReports(shown, preferences),
      arrangeCards,
      isCardOn: (reportId) => !isUsageCardOff(preferences, reportId),
      setCardOn,
    }),
    [arrangeCards, preferences, reports, setCardOn, setDisplayAs, togglePin],
  );
  return { preferences, display };
}

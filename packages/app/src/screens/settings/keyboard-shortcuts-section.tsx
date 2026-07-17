import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { View, Text } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { StyleSheet } from "react-native-unistyles";
import { settingsStyles } from "@/styles/settings";
import { SettingsSection } from "@/screens/settings/settings-section";
import { Button } from "@/components/ui/button";
import { Shortcut } from "@/components/ui/shortcut";
import { useKeyboardShortcutOverrides } from "@/hooks/use-keyboard-shortcut-overrides";
import {
  buildKeyboardShortcutHelpSections,
  getBindingIdForAction,
  type KeyboardShortcutHelpRow,
} from "@/keyboard/keyboard-shortcuts";
import {
  chordStringToShortcutKeys,
  comboStringToShortcutKeys,
  heldModifiersFromEvent,
  keyboardEventToComboString,
} from "@/keyboard/shortcut-string";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { getShortcutOs } from "@/utils/shortcut-platform";
import { getIsElectronRuntime } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { getDesktopHost } from "@/desktop/host";

const EMPTY_CAPTURED_COMBOS: string[] = [];

function ShortcutSequence({
  chord,
  heldModifiers,
}: {
  chord: string[] | null;
  heldModifiers: string | null;
}) {
  const { t } = useTranslation();
  const displayChord = useMemo(() => {
    const combos = [...(chord ?? [])];
    if (heldModifiers) {
      combos.push(heldModifiers);
    }
    return combos.map(comboStringToShortcutKeys);
  }, [chord, heldModifiers]);

  if ((!chord || chord.length === 0) && !heldModifiers) {
    return <Text style={styles.capturingText}>{t("settings.shortcuts.capturePrompt")}</Text>;
  }

  return <Shortcut chord={displayChord} />;
}

interface ShortcutRowContainerProps {
  row: KeyboardShortcutHelpRow;
  bindingId: string | null;
  overrideCombo: string | undefined;
  isCapturing: boolean;
  capturedCombos: string[];
  heldModifiers: string | null;
  onStartCapture: (bindingId: string) => void;
  onSaveCapture: () => void;
  onCancelCapture: () => void;
  onRemoveOverride: (bindingId: string) => void;
}

function ShortcutRowContainer({
  row,
  bindingId,
  overrideCombo,
  isCapturing,
  capturedCombos,
  heldModifiers,
  onStartCapture,
  onSaveCapture,
  onCancelCapture,
  onRemoveOverride,
}: ShortcutRowContainerProps) {
  const handleRebind = useCallback(() => {
    if (bindingId) onStartCapture(bindingId);
  }, [bindingId, onStartCapture]);

  const handleReset = useCallback(() => {
    if (bindingId) onRemoveOverride(bindingId);
  }, [bindingId, onRemoveOverride]);

  return (
    <ShortcutRow
      row={row}
      bindingId={bindingId}
      overrideCombo={overrideCombo}
      isCapturing={isCapturing}
      capturedCombos={capturedCombos}
      heldModifiers={heldModifiers}
      onRebind={handleRebind}
      onDone={onSaveCapture}
      onCancel={onCancelCapture}
      onReset={handleReset}
    />
  );
}

function ShortcutRow({
  row,
  bindingId,
  overrideCombo,
  isCapturing,
  capturedCombos,
  heldModifiers,
  onRebind,
  onDone,
  onCancel,
  onReset,
}: {
  row: KeyboardShortcutHelpRow;
  bindingId: string | null;
  overrideCombo: string | undefined;
  isCapturing: boolean;
  capturedCombos: string[];
  heldModifiers: string | null;
  onRebind: () => void;
  onDone: () => void;
  onCancel: () => void;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  const displayChord = useMemo(
    () => (overrideCombo ? chordStringToShortcutKeys(overrideCombo) : [row.keys]),
    [overrideCombo, row.keys],
  );
  const rowStyle = useMemo(() => [styles.row, isCapturing && styles.rowCapturing], [isCapturing]);

  return (
    <View style={rowStyle}>
      <Text style={styles.rowLabel}>{t(row.labelKey)}</Text>
      <View style={styles.rowActions}>
        {isCapturing ? (
          <ShortcutSequence chord={capturedCombos} heldModifiers={heldModifiers} />
        ) : (
          <Shortcut chord={displayChord} />
        )}
        {bindingId !== null && (
          <>
            {isCapturing && capturedCombos.length > 0 ? (
              <Button variant="ghost" size="sm" onPress={onDone}>
                {t("settings.shortcuts.actions.done")}
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" onPress={isCapturing ? onCancel : onRebind}>
              {isCapturing
                ? t("settings.shortcuts.actions.cancel")
                : t("settings.shortcuts.actions.rebind")}
            </Button>
          </>
        )}
        {overrideCombo !== undefined && !isCapturing && (
          <Button variant="ghost" size="sm" onPress={onReset}>
            <Text style={styles.resetText}>{t("settings.shortcuts.actions.reset")}</Text>
          </Button>
        )}
      </View>
    </View>
  );
}

export function KeyboardShortcutsSection() {
  const { t } = useTranslation();
  const [capturingBindingId, setCapturingBindingId] = useState<string | null>(null);
  const [capturedCombos, setCapturedCombos] = useState<string[]>([]);
  const [heldModifiers, setHeldModifiers] = useState<string | null>(null);
  const { overrides, hasOverrides, setOverride, removeOverride, resetAll } =
    useKeyboardShortcutOverrides();
  const setCapturingShortcut = useKeyboardShortcutsStore((s) => s.setCapturingShortcut);
  const capturing = useKeyboardShortcutsStore((s) => s.capturingShortcut);

  const isFocused = useIsFocused();
  const isMac = getShortcutOs() === "mac";
  const isDesktopApp = getIsElectronRuntime();
  const sections = buildKeyboardShortcutHelpSections({ isMac, isDesktop: isDesktopApp });

  const cancelCapture = useCallback(() => {
    setCapturedCombos([]);
    setHeldModifiers(null);
    setCapturingBindingId(null);
    setCapturingShortcut(false);
  }, [setCapturingShortcut]);

  const startCapture = useCallback(
    (bindingId: string) => {
      setCapturedCombos([]);
      setHeldModifiers(null);
      setCapturingBindingId(bindingId);
      setCapturingShortcut(true);
    },
    [setCapturingShortcut],
  );

  const saveCapture = useCallback(() => {
    if (capturingBindingId === null || capturedCombos.length === 0) {
      return;
    }
    void setOverride(capturingBindingId, capturedCombos.join(" "));
    cancelCapture();
  }, [capturingBindingId, capturedCombos, setOverride, cancelCapture]);

  useEffect(() => {
    if (!isFocused && capturingBindingId !== null) {
      cancelCapture();
    }
  }, [isFocused, capturingBindingId, cancelCapture]);

  useEffect(() => {
    if (isNative) return;
    if (capturingBindingId === null) return;

    function handleKeyDown(event: KeyboardEvent) {
      event.preventDefault();
      event.stopPropagation();

      const key = event.key ?? "";
      if (key === "Backspace") {
        setCapturedCombos((current) => (current.length > 0 ? current.slice(0, -1) : current));
        return;
      }

      const comboString = keyboardEventToComboString(event);
      if (comboString === null) {
        setHeldModifiers(heldModifiersFromEvent(event));
        return;
      }

      setHeldModifiers(null);
      setCapturedCombos((current) => [...current, comboString]);
    }

    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [capturingBindingId]);

  useEffect(() => {
    return () => {
      setCapturingShortcut(false);
    };
  }, [setCapturingShortcut]);

  // Suppress desktop zoom accelerators while capturing so combos like Cmd+- are
  // recorded instead of zooming the window. No-op outside Electron.
  useEffect(() => {
    if (isNative || !capturing) return;
    const menu = getDesktopHost()?.menu;
    void menu?.setCapturingShortcut?.(true);
    return () => {
      void menu?.setCapturingShortcut?.(false);
    };
  }, [capturing]);

  const handleResetAll = useCallback(() => void resetAll(), [resetAll]);
  const handleRemoveOverride = useCallback(
    (bindingId: string) => void removeOverride(bindingId),
    [removeOverride],
  );

  if (isNative) {
    return (
      <SettingsSection title={t("settings.sections.shortcuts")}>
        <View style={mobileCardStyle}>
          <Text style={styles.mobileText}>{t("settings.shortcuts.unavailableOnMobile")}</Text>
        </View>
      </SettingsSection>
    );
  }

  const resetAllButton = hasOverrides ? (
    <Button variant="ghost" size="sm" onPress={handleResetAll}>
      {t("settings.shortcuts.actions.resetAll")}
    </Button>
  ) : undefined;

  return (
    <>
      {sections.map(function (section, sectionIndex) {
        return (
          <SettingsSection
            key={section.id}
            title={t(section.titleKey)}
            trailing={sectionIndex === 0 ? resetAllButton : undefined}
          >
            <View style={settingsStyles.card}>
              {section.rows.map(function (row, index) {
                const bindingId = getBindingIdForAction(row.id, {
                  isMac,
                  isDesktop: isDesktopApp,
                });
                const overrideCombo = bindingId ? overrides[bindingId] : undefined;

                return (
                  <View key={row.id}>
                    <ShortcutRowContainer
                      row={row}
                      bindingId={bindingId}
                      overrideCombo={overrideCombo}
                      isCapturing={capturingBindingId === bindingId}
                      capturedCombos={
                        capturingBindingId === bindingId ? capturedCombos : EMPTY_CAPTURED_COMBOS
                      }
                      heldModifiers={capturingBindingId === bindingId ? heldModifiers : null}
                      onStartCapture={startCapture}
                      onSaveCapture={saveCapture}
                      onCancelCapture={cancelCapture}
                      onRemoveOverride={handleRemoveOverride}
                    />
                    {index < section.rows.length - 1 && <View style={styles.separator} />}
                  </View>
                );
              })}
            </View>
          </SettingsSection>
        );
      })}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
  },
  rowCapturing: {
    backgroundColor: theme.colors.surface2,
  },
  rowLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    flexShrink: 1,
  },
  rowActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  capturingText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  resetText: {
    color: theme.colors.foregroundMuted,
  },
  separator: {
    height: 1,
    backgroundColor: theme.colors.border,
  },
  mobileCard: {
    padding: theme.spacing[4],
  },
  mobileText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));

const mobileCardStyle = [settingsStyles.card, styles.mobileCard];

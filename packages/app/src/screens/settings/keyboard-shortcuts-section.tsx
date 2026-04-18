import { useState, useEffect } from "react";
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

function ShortcutSequence({
  chord,
  heldModifiers,
}: {
  chord: string[] | null;
  heldModifiers: string | null;
}) {
  if ((!chord || chord.length === 0) && !heldModifiers) {
    return <Text style={styles.capturingText}>Press shortcut...</Text>;
  }

  const displayCombos = [...(chord ?? [])];
  if (heldModifiers) {
    displayCombos.push(heldModifiers);
  }

  return <Shortcut chord={displayCombos.map(comboStringToShortcutKeys)} />;
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
  const displayChord = overrideCombo ? chordStringToShortcutKeys(overrideCombo) : [row.keys];

  return (
    <View style={[styles.row, isCapturing && styles.rowCapturing]}>
      <Text style={styles.rowLabel}>{row.label}</Text>
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
                Done
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" onPress={isCapturing ? onCancel : onRebind}>
              {isCapturing ? "Cancel" : "Rebind"}
            </Button>
          </>
        )}
        {overrideCombo !== undefined && !isCapturing && (
          <Button variant="ghost" size="sm" onPress={onReset}>
            <Text style={styles.resetText}>Reset</Text>
          </Button>
        )}
      </View>
    </View>
  );
}

export function KeyboardShortcutsSection() {
  const [capturingBindingId, setCapturingBindingId] = useState<string | null>(null);
  const [capturedCombos, setCapturedCombos] = useState<string[]>([]);
  const [heldModifiers, setHeldModifiers] = useState<string | null>(null);
  const { overrides, hasOverrides, setOverride, removeOverride, resetAll } =
    useKeyboardShortcutOverrides();
  const setCapturingShortcut = useKeyboardShortcutsStore((s) => s.setCapturingShortcut);

  const isFocused = useIsFocused();
  const isMac = getShortcutOs() === "mac";
  const isDesktopApp = getIsElectronRuntime();
  const sections = buildKeyboardShortcutHelpSections({ isMac, isDesktop: isDesktopApp });

  useEffect(() => {
    if (!isFocused && capturingBindingId !== null) {
      cancelCapture();
    }
  }, [isFocused]);

  function cancelCapture() {
    setCapturedCombos([]);
    setHeldModifiers(null);
    setCapturingBindingId(null);
    setCapturingShortcut(false);
  }

  function startCapture(bindingId: string) {
    setCapturedCombos([]);
    setHeldModifiers(null);
    setCapturingBindingId(bindingId);
    setCapturingShortcut(true);
  }

  function saveCapture() {
    if (capturingBindingId === null || capturedCombos.length === 0) {
      return;
    }
    void setOverride(capturingBindingId, capturedCombos.join(" "));
    cancelCapture();
  }

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

  if (isNative) {
    return (
      <SettingsSection title="Shortcuts">
        <View style={[settingsStyles.card, styles.mobileCard]}>
          <Text style={styles.mobileText}>Keyboard shortcuts are only available on desktop.</Text>
        </View>
      </SettingsSection>
    );
  }

  const resetAllButton = hasOverrides ? (
    <Button variant="ghost" size="sm" onPress={() => void resetAll()}>
      Reset all
    </Button>
  ) : undefined;

  return (
    <>
      {sections.map(function (section, sectionIndex) {
        return (
          <SettingsSection
            key={section.id}
            title={section.title}
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
                    <ShortcutRow
                      row={row}
                      bindingId={bindingId}
                      overrideCombo={overrideCombo}
                      isCapturing={capturingBindingId === bindingId}
                      capturedCombos={capturingBindingId === bindingId ? capturedCombos : []}
                      heldModifiers={capturingBindingId === bindingId ? heldModifiers : null}
                      onRebind={() => {
                        if (bindingId) {
                          startCapture(bindingId);
                        }
                      }}
                      onDone={saveCapture}
                      onCancel={cancelCapture}
                      onReset={() => {
                        if (bindingId) void removeOverride(bindingId);
                      }}
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

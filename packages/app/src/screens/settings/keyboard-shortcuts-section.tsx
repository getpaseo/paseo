import { useState, useEffect } from "react";
import { View, Text, Platform } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { settingsStyles } from "@/styles/settings";
import { Button } from "@/components/ui/button";
import { Shortcut } from "@/components/ui/shortcut";
import { useKeyboardShortcutOverrides } from "@/hooks/use-keyboard-shortcut-overrides";
import {
  buildKeyboardShortcutHelpSections,
  getBindingIdForAction,
  type KeyboardShortcutHelpRow,
} from "@/keyboard/keyboard-shortcuts";
import { comboStringToShortcutKeys, keyboardEventToComboString } from "@/keyboard/shortcut-string";
import { getShortcutOs } from "@/utils/shortcut-platform";
import { getIsDesktop } from "@/constants/layout";

function ShortcutRow({
  row,
  bindingId,
  overrideCombo,
  isCapturing,
  onRebind,
  onCancel,
  onReset,
}: {
  row: KeyboardShortcutHelpRow;
  bindingId: string | null;
  overrideCombo: string | undefined;
  isCapturing: boolean;
  onRebind: () => void;
  onCancel: () => void;
  onReset: () => void;
}) {
  const displayKeys = overrideCombo ? comboStringToShortcutKeys(overrideCombo) : row.keys;

  return (
    <View style={[styles.row, isCapturing && styles.rowCapturing]}>
      <Text style={styles.rowLabel}>{row.label}</Text>
      <View style={styles.rowActions}>
        {isCapturing ? (
          <Text style={styles.capturingText}>Press shortcut...</Text>
        ) : (
          <Shortcut keys={displayKeys} />
        )}
        {bindingId !== null && (
          <Button
            variant="ghost"
            size="sm"
            onPress={isCapturing ? onCancel : onRebind}
          >
            {isCapturing ? "Cancel" : "Rebind"}
          </Button>
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
  const { overrides, hasOverrides, setOverride, removeOverride, resetAll } =
    useKeyboardShortcutOverrides();

  const isMac = getShortcutOs() === "mac";
  const isDesktop = getIsDesktop();
  const sections = buildKeyboardShortcutHelpSections({ isMac, isDesktop });

  useEffect(() => {
    if (Platform.OS !== "web") return;
    if (capturingBindingId === null) return;

    const activeBindingId = capturingBindingId;

    function handleKeyDown(event: KeyboardEvent) {
      const key = event.key ?? "";
      if (key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setCapturingBindingId(null);
        return;
      }

      if (key === "Alt" || key === "Control" || key === "Meta" || key === "Shift") {
        return;
      }

      const comboString = keyboardEventToComboString(event);
      if (comboString === null) return;

      event.preventDefault();
      event.stopPropagation();
      void setOverride(activeBindingId, comboString);
      setCapturingBindingId(null);
    }

    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [capturingBindingId, setOverride]);

  if (Platform.OS !== "web") {
    return (
      <View style={settingsStyles.section}>
        <Text style={settingsStyles.sectionTitle}>Keyboard Shortcuts</Text>
        <View style={[settingsStyles.card, styles.mobileCard]}>
          <Text style={styles.mobileText}>
            Keyboard shortcuts are only available on desktop.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={settingsStyles.section}>
      <View style={styles.sectionHeader}>
        <Text style={settingsStyles.sectionTitle}>Keyboard Shortcuts</Text>
        {hasOverrides && (
          <Button variant="ghost" size="sm" onPress={() => void resetAll()}>
            Reset all
          </Button>
        )}
      </View>

      {sections.map(function (section) {
        return (
          <View key={section.id}>
            <Text style={styles.subsectionTitle}>{section.title}</Text>
            <View style={settingsStyles.card}>
              {section.rows.map(function (row, index) {
                const bindingId = getBindingIdForAction(row.id, { isMac, isDesktop });
                const overrideCombo = bindingId ? overrides[bindingId] : undefined;

                return (
                  <View key={row.id}>
                    <ShortcutRow
                      row={row}
                      bindingId={bindingId}
                      overrideCombo={overrideCombo}
                      isCapturing={capturingBindingId === bindingId}
                      onRebind={() => setCapturingBindingId(bindingId)}
                      onCancel={() => setCapturingBindingId(null)}
                      onReset={() => {
                        if (bindingId) void removeOverride(bindingId);
                      }}
                    />
                    {index < section.rows.length - 1 && <View style={styles.separator} />}
                  </View>
                );
              })}
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  sectionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  subsectionTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    marginBottom: theme.spacing[2],
    marginTop: theme.spacing[4],
    marginLeft: theme.spacing[1],
  },
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

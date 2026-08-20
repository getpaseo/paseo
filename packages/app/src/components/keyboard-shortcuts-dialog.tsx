import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { getIsElectronRuntime } from "@/constants/layout";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Shortcut } from "@/components/ui/shortcut";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { getShortcutOs } from "@/utils/shortcut-platform";
import {
  buildEffectiveBindings,
  buildKeyboardShortcutHelpSections,
} from "@/keyboard/keyboard-shortcuts";
import { filterShortcutHelpSections } from "@/keyboard/shortcut-help-search";
import { useKeyboardShortcutOverrides } from "@/hooks/use-keyboard-shortcut-overrides";

const SNAP_POINTS: string[] = ["70%", "92%"];

export function KeyboardShortcutsDialog() {
  const { t } = useTranslation();
  const open = useKeyboardShortcutsStore((s) => s.shortcutsDialogOpen);
  const setOpen = useKeyboardShortcutsStore((s) => s.setShortcutsDialogOpen);
  const [query, setQuery] = useState("");

  const shortcutOs = getShortcutOs();
  const isMac = shortcutOs === "mac";
  const isDesktopApp = getIsElectronRuntime();
  const { overrides } = useKeyboardShortcutOverrides();
  // Effective bindings, so a shortcut the user unassigned lists no keys here
  // instead of advertising a default that no longer fires.
  const bindings = useMemo(() => buildEffectiveBindings(overrides), [overrides]);
  const sections = useMemo(
    () => buildKeyboardShortcutHelpSections({ isMac, isDesktop: isDesktopApp }, bindings),
    [bindings, isDesktopApp, isMac],
  );
  const visibleSections = useMemo(
    () => filterShortcutHelpSections({ sections, query, translate: t, shortcutOs }),
    [query, sections, shortcutOs, t],
  );

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const handleClose = useCallback(() => setOpen(false), [setOpen]);
  const header = useMemo<SheetHeader>(
    () => ({
      title: t("settings.shortcuts.dialogTitle"),
      search: {
        onChange: setQuery,
        resetKey: Number(open),
        placeholder: t("settings.shortcuts.searchPlaceholder"),
        autoFocus: true,
      },
    }),
    [open, t],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={open}
      onClose={handleClose}
      testID="keyboard-shortcuts-dialog"
      snapPoints={SNAP_POINTS}
    >
      <View testID="keyboard-shortcuts-dialog-content" style={styles.content}>
        {visibleSections.map((section) => (
          <View key={section.title} style={styles.section}>
            <Text style={styles.sectionTitle}>{t(section.titleKey)}</Text>
            <View style={styles.rows}>
              {section.rows.map((row) => (
                <View key={row.id} style={styles.row} testID={`shortcut-help-row-${row.id}`}>
                  <View style={styles.rowText}>
                    <Text style={styles.rowLabel}>{t(row.labelKey)}</Text>
                    {row.note ? (
                      <Text style={styles.rowNote}>{row.noteKey ? t(row.noteKey) : row.note}</Text>
                    ) : null}
                  </View>
                  {row.chord === null ? (
                    <Text style={styles.rowUnassigned}>{t("settings.shortcuts.unassigned")}</Text>
                  ) : (
                    <Shortcut chord={row.chord} style={styles.rowShortcut} />
                  )}
                </View>
              ))}
            </View>
          </View>
        ))}
        {visibleSections.length === 0 ? (
          <Text style={styles.empty}>{t("common.empty.noResults")}</Text>
        ) : null}
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: {
    gap: theme.spacing[4],
  },
  section: {
    gap: theme.spacing[2],
  },
  sectionTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  rows: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.surface2,
  },
  rowText: {
    flex: 1,
    minWidth: 0,
  },
  rowLabel: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
  },
  rowNote: {
    marginTop: 2,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  rowShortcut: {
    alignSelf: "flex-start",
  },
  // Matches the settings row's unassigned label, so the two screens describe the
  // same state the same way.
  rowUnassigned: {
    alignSelf: "flex-start",
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
  },
  empty: {
    paddingVertical: theme.spacing[6],
    textAlign: "center",
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
  },
}));

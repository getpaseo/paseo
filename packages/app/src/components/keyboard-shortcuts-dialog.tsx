import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { getIsElectronRuntime } from "@/constants/layout";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Shortcut } from "@/components/ui/shortcut";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { formatShortcut } from "@/utils/format-shortcut";
import { getShortcutOs } from "@/utils/shortcut-platform";
import { buildKeyboardShortcutHelpSections } from "@/keyboard/keyboard-shortcuts";

const SNAP_POINTS: string[] = ["70%", "92%"];

function shortcutSearchAliases(keys: string[], shortcutOs: "mac" | "non-mac"): string {
  const aliases = keys.map((key) => {
    if (shortcutOs === "mac") {
      if (key === "mod" || key === "meta") return ["cmd", "command"];
      if (key === "alt") return ["alt", "option"];
    } else {
      if (key === "mod" || key === "ctrl") return ["ctrl", "control"];
      if (key === "meta") return ["win", "windows"];
    }
    return [key];
  });
  const combinations = aliases.reduce<string[][]>(
    (prefixes, choices) =>
      prefixes.flatMap((prefix) => choices.map((choice) => [...prefix, choice])),
    [[]],
  );
  return combinations
    .flatMap((combination) => [combination.join(" "), combination.join("+")])
    .join(" ");
}

export function KeyboardShortcutsDialog() {
  const { t } = useTranslation();
  const open = useKeyboardShortcutsStore((s) => s.shortcutsDialogOpen);
  const setOpen = useKeyboardShortcutsStore((s) => s.setShortcutsDialogOpen);
  const [query, setQuery] = useState("");

  const shortcutOs = getShortcutOs();
  const isMac = shortcutOs === "mac";
  const isDesktopApp = getIsElectronRuntime();
  const sections = useMemo(
    () => buildKeyboardShortcutHelpSections({ isMac, isDesktop: isDesktopApp }),
    [isDesktopApp, isMac],
  );
  const visibleSections = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return sections;

    return sections.flatMap((section) => {
      const sectionTitle = t(section.titleKey);
      if (sectionTitle.toLocaleLowerCase().includes(normalizedQuery)) {
        return [section];
      }

      const rows = section.rows.filter((row) => {
        const searchText = [
          t(row.labelKey),
          row.noteKey ? t(row.noteKey) : row.note,
          row.keys.join(" "),
          formatShortcut(row.keys, shortcutOs),
          shortcutSearchAliases(row.keys, shortcutOs),
        ]
          .filter(Boolean)
          .join(" ")
          .toLocaleLowerCase();
        return searchText.includes(normalizedQuery);
      });

      return rows.length > 0 ? [{ ...section, rows }] : [];
    });
  }, [query, sections, shortcutOs, t]);

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
                <View key={row.id} style={styles.row}>
                  <View style={styles.rowText}>
                    <Text style={styles.rowLabel}>{t(row.labelKey)}</Text>
                    {row.note ? (
                      <Text style={styles.rowNote}>{row.noteKey ? t(row.noteKey) : row.note}</Text>
                    ) : null}
                  </View>
                  <Shortcut keys={row.keys} style={styles.rowShortcut} />
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
    fontSize: theme.fontSize.xs,
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
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  rowNote: {
    marginTop: 2,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  rowShortcut: {
    alignSelf: "flex-start",
  },
  empty: {
    paddingVertical: theme.spacing[6],
    textAlign: "center",
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));

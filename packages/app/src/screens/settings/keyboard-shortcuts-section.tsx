import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { View, Text, type PressableStateCallbackType } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { MoreHorizontal, Pencil, Undo2, X } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { settingsStyles } from "@/styles/settings";
import { SettingsSection } from "@/screens/settings/settings-section";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Shortcut } from "@/components/ui/shortcut";
import { useKeyboardShortcutOverrides } from "@/hooks/use-keyboard-shortcut-overrides";
import {
  buildKeyboardShortcutHelpSections,
  getBindingIdForAction,
  getDefaultKeysForAction,
  resolveShortcutKeysForAction,
  type KeyboardShortcutHelpRow,
} from "@/keyboard/keyboard-shortcuts";
import {
  comboStringToShortcutKeys,
  heldModifiersFromEvent,
  keyboardEventToComboString,
} from "@/keyboard/shortcut-string";
import type { ShortcutKey } from "@/utils/format-shortcut";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { getShortcutOs } from "@/utils/shortcut-platform";
import { getIsElectronRuntime } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { getDesktopHost } from "@/desktop/host";

const EMPTY_CAPTURED_COMBOS: string[] = [];

const ThemedMoreHorizontal = withUnistyles(MoreHorizontal);
const ThemedPencil = withUnistyles(Pencil);
const ThemedUndo2 = withUnistyles(Undo2);
const ThemedX = withUnistyles(X);

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const bindLeadingIcon = <ThemedPencil size={14} uniProps={foregroundMutedColorMapping} />;
const clearLeadingIcon = <ThemedX size={14} uniProps={foregroundMutedColorMapping} />;
const resetLeadingIcon = <ThemedUndo2 size={14} uniProps={foregroundMutedColorMapping} />;

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
  displayChord: ShortcutKey[][] | null;
  hasOverride: boolean;
  hasDefault: boolean;
  isCapturing: boolean;
  capturedCombos: string[];
  heldModifiers: string | null;
  onStartCapture: (bindingId: string) => void;
  onSaveCapture: () => void;
  onCancelCapture: () => void;
  onClearOverride: (bindingId: string) => void;
  onRemoveOverride: (bindingId: string) => void;
}

function ShortcutRowContainer({
  row,
  bindingId,
  displayChord,
  hasOverride,
  hasDefault,
  isCapturing,
  capturedCombos,
  heldModifiers,
  onStartCapture,
  onSaveCapture,
  onCancelCapture,
  onClearOverride,
  onRemoveOverride,
}: ShortcutRowContainerProps) {
  const handleRebind = useCallback(() => {
    if (bindingId) onStartCapture(bindingId);
  }, [bindingId, onStartCapture]);

  const handleClear = useCallback(() => {
    if (bindingId) onClearOverride(bindingId);
  }, [bindingId, onClearOverride]);

  const handleReset = useCallback(() => {
    if (bindingId) onRemoveOverride(bindingId);
  }, [bindingId, onRemoveOverride]);

  return (
    <ShortcutRow
      row={row}
      bindingId={bindingId}
      displayChord={displayChord}
      hasOverride={hasOverride}
      hasDefault={hasDefault}
      isCapturing={isCapturing}
      capturedCombos={capturedCombos}
      heldModifiers={heldModifiers}
      onRebind={handleRebind}
      onDone={onSaveCapture}
      onCancel={onCancelCapture}
      onClear={handleClear}
      onReset={handleReset}
    />
  );
}

function ShortcutRowKeys({
  displayChord,
  isCapturing,
  capturedCombos,
  heldModifiers,
}: {
  displayChord: ShortcutKey[][] | null;
  isCapturing: boolean;
  capturedCombos: string[];
  heldModifiers: string | null;
}) {
  const { t } = useTranslation();

  if (isCapturing) {
    return <ShortcutSequence chord={capturedCombos} heldModifiers={heldModifiers} />;
  }
  if (displayChord === null) {
    return <Text style={styles.unassignedText}>{t("settings.shortcuts.unassigned")}</Text>;
  }
  return <Shortcut chord={displayChord} />;
}

function ShortcutActionsMenu({
  row,
  bindLabel,
  showClear,
  showReset,
  onRebind,
  onClear,
  onReset,
}: {
  row: KeyboardShortcutHelpRow;
  bindLabel: "bind" | "rebind";
  showClear: boolean;
  showReset: boolean;
  onRebind: () => void;
  onClear: () => void;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  const triggerStyle = useCallback(
    ({
      pressed,
      hovered,
      open,
    }: PressableStateCallbackType & { hovered?: boolean; open?: boolean }) => [
      styles.menuButton,
      (hovered || open) && styles.menuButtonHovered,
      pressed && styles.menuButtonPressed,
    ],
    [],
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        hitSlop={8}
        style={triggerStyle}
        accessibilityRole="button"
        accessibilityLabel={t("settings.shortcuts.actions.menu", { name: t(row.labelKey) })}
        testID={`shortcut-actions-${row.id}`}
      >
        {({ hovered, open }) => (
          <ThemedMoreHorizontal
            size={14}
            uniProps={hovered || open ? foregroundColorMapping : foregroundMutedColorMapping}
          />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={220}>
        <DropdownMenuItem
          leading={bindLeadingIcon}
          onSelect={onRebind}
          testID={`shortcut-bind-${row.id}`}
        >
          {t(`settings.shortcuts.actions.${bindLabel}`)}
        </DropdownMenuItem>
        {showClear && (
          <DropdownMenuItem
            leading={clearLeadingIcon}
            onSelect={onClear}
            testID={`shortcut-clear-${row.id}`}
          >
            {t("settings.shortcuts.actions.clear")}
          </DropdownMenuItem>
        )}
        {showReset && (
          <DropdownMenuItem
            leading={resetLeadingIcon}
            onSelect={onReset}
            testID={`shortcut-reset-${row.id}`}
          >
            {t("settings.shortcuts.actions.reset")}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ShortcutRow({
  row,
  bindingId,
  displayChord,
  hasOverride,
  hasDefault,
  isCapturing,
  capturedCombos,
  heldModifiers,
  onRebind,
  onDone,
  onCancel,
  onClear,
  onReset,
}: {
  row: KeyboardShortcutHelpRow;
  bindingId: string | null;
  displayChord: ShortcutKey[][] | null;
  hasOverride: boolean;
  hasDefault: boolean;
  isCapturing: boolean;
  capturedCombos: string[];
  heldModifiers: string | null;
  onRebind: () => void;
  onDone: () => void;
  onCancel: () => void;
  onClear: () => void;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  const rowStyle = useMemo(() => [styles.row, isCapturing && styles.rowCapturing], [isCapturing]);

  const isBindable = bindingId !== null;
  const showDone = isCapturing && capturedCombos.length > 0;
  const showClear = displayChord !== null;
  // Reset restores the default, so it is only meaningful when there is a
  // default to restore. A binding that ships without one would otherwise show a
  // Reset that lands on the same "Not set" state Clear already produced.
  const showReset = hasOverride && hasDefault;
  // Nothing is bound in the unassigned state, so there is nothing to *re*-bind.
  const bindLabel = displayChord === null ? "bind" : "rebind";

  return (
    <View style={rowStyle}>
      <Text style={styles.rowLabel}>{t(row.labelKey)}</Text>
      <View style={styles.rowActions}>
        <View style={styles.rowKeys}>
          <ShortcutRowKeys
            displayChord={displayChord}
            isCapturing={isCapturing}
            capturedCombos={capturedCombos}
            heldModifiers={heldModifiers}
          />
        </View>
        {isCapturing ? (
          <>
            {showDone && (
              <Button variant="ghost" size="sm" onPress={onDone}>
                {t("settings.shortcuts.actions.done")}
              </Button>
            )}
            {isBindable && (
              <Button variant="ghost" size="sm" onPress={onCancel}>
                {t("settings.shortcuts.actions.cancel")}
              </Button>
            )}
          </>
        ) : (
          // Fixed slot, occupied or not, so the keys column keeps one rail on
          // every row instead of sliding with whatever actions the row offers.
          <View style={styles.menuSlot}>
            {isBindable && (
              <ShortcutActionsMenu
                row={row}
                bindLabel={bindLabel}
                showClear={showClear}
                showReset={showReset}
                onRebind={onRebind}
                onClear={onClear}
                onReset={onReset}
              />
            )}
          </View>
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
  const { overrides, hasOverrides, setOverride, clearOverride, removeOverride, resetAll } =
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
  const handleClearOverride = useCallback(
    (bindingId: string) => void clearOverride(bindingId),
    [clearOverride],
  );
  const handleRemoveOverride = useCallback(
    (bindingId: string) => void removeOverride(bindingId),
    [removeOverride],
  );

  if (isNative) {
    return (
      <SettingsSection title={t("settings.sections.shortcuts")}>
        <View style={[settingsStyles.card, styles.mobileCard]}>
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
                const platform = { isMac, isDesktop: isDesktopApp };
                const bindingId = getBindingIdForAction(row.id, platform);
                const displayChord = resolveShortcutKeysForAction(row.id, overrides, platform);
                // `in`, not a truthiness check: an unassigned shortcut stores
                // null, and Reset has to stay available to undo it.
                const hasOverride = bindingId !== null && bindingId in overrides;
                // A binding authored with `combo: ""` has nothing to reset to.
                const hasDefault = getDefaultKeysForAction(row.id, platform) !== null;

                return (
                  <View key={row.id}>
                    <ShortcutRowContainer
                      row={row}
                      bindingId={bindingId}
                      displayChord={displayChord}
                      hasOverride={hasOverride}
                      hasDefault={hasDefault}
                      isCapturing={capturingBindingId === bindingId}
                      capturedCombos={
                        capturingBindingId === bindingId ? capturedCombos : EMPTY_CAPTURED_COMBOS
                      }
                      heldModifiers={capturingBindingId === bindingId ? heldModifiers : null}
                      onStartCapture={startCapture}
                      onSaveCapture={saveCapture}
                      onCancelCapture={cancelCapture}
                      onClearOverride={handleClearOverride}
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
  rowKeys: {
    alignItems: "flex-end",
  },
  menuSlot: {
    width: 32,
    height: 32,
  },
  menuButton: {
    width: 32,
    height: 32,
    borderRadius: theme.borderRadius.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  menuButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  menuButtonPressed: {
    backgroundColor: theme.colors.surface3,
  },
  capturingText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  unassignedText: {
    fontSize: theme.fontSize.sm,
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

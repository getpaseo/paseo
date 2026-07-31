import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Check } from "lucide-react-native";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";
import { confirmDialog } from "@/utils/confirm-dialog";
import { skillsRemovedBySave } from "@/desktop/components/skill-removal";
import type { SkillSelection } from "@/desktop/daemon/desktop-daemon";

const ThemedCheck = withUnistyles(Check);
const checkedIconMapping = (theme: Theme) => ({ color: theme.colors.accentForeground });

interface SkillSelectionSheetProps {
  visible: boolean;
  available: readonly string[];
  selection: SkillSelection;
  installed: readonly string[];
  isSaving: boolean;
  onSave: (selection: SkillSelection) => Promise<void>;
  onClose: () => void;
}

function isSkillSelected(draft: SkillSelection, name: string): boolean {
  return draft.mode === "all" || draft.skills.includes(name);
}

/**
 * Draft form state only. The saved selection, the convergence across agent skill
 * directories, and the resulting status all belong to the desktop skills module.
 */
export function SkillSelectionSheet({
  visible,
  available,
  selection,
  installed,
  isSaving,
  onSave,
  onClose,
}: SkillSelectionSheetProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<SkillSelection>(selection);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Reopening starts from what is saved, so a cancelled edit leaves nothing behind.
  useEffect(() => {
    if (!visible) return;
    setDraft(selection);
    setSaveError(null);
  }, [selection, visible]);

  const handleToggleAll = useCallback(
    (nextAll: boolean) => {
      // Leaving `all` keeps every currently installed skill checked, so turning
      // the switch off is a starting point rather than a reset.
      setDraft(nextAll ? { mode: "all" } : { mode: "custom", skills: [...available] });
    },
    [available],
  );

  const handleToggleSkill = useCallback((name: string) => {
    setDraft((current) => {
      if (current.mode === "all") return current;
      const skills = current.skills.includes(name)
        ? current.skills.filter((skill) => skill !== name)
        : [...current.skills, name].sort();
      return { mode: "custom", skills };
    });
  }, []);

  const removedSkills = useMemo(
    () => skillsRemovedBySave({ draft, available, installed }),
    [available, draft, installed],
  );

  const handleSave = useCallback(() => {
    void (async () => {
      setSaveError(null);
      // Removing a skill deletes its directory in every agent home, including
      // anything the user put inside it, so it is confirmed like any other
      // destructive action. Adding skills and re-saving the same set do not ask.
      if (removedSkills.length > 0) {
        const confirmed = await confirmDialog({
          title: t("settings.integrations.skills.removeTitle"),
          message: t("settings.integrations.skills.removeMessage", {
            skills: removedSkills.join(", "),
          }),
          confirmLabel: t("settings.integrations.actions.remove"),
          destructive: true,
        });
        if (!confirmed) return;
      }
      try {
        await onSave(draft);
        onClose();
      } catch {
        setSaveError(t("settings.integrations.skills.saveFailed"));
      }
    })();
  }, [draft, onClose, onSave, removedSkills, t]);

  const header = useMemo<SheetHeader>(
    () => ({ title: t("settings.integrations.skills.choose") }),
    [t],
  );

  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button
          style={styles.footerButton}
          variant="secondary"
          onPress={onClose}
          disabled={isSaving}
        >
          {t("common.actions.cancel")}
        </Button>
        <Button
          style={styles.footerButton}
          variant="default"
          onPress={handleSave}
          loading={isSaving}
          testID="skill-selection-save"
        >
          {isSaving
            ? t("settings.integrations.actions.saving")
            : t("settings.integrations.actions.save")}
        </Button>
      </View>
    ),
    [handleSave, isSaving, onClose, t],
  );

  const allSkills = draft.mode === "all";

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      footer={footer}
      testID="skill-selection-sheet"
    >
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>
              {t("settings.integrations.skills.chooseAll")}
            </Text>
            <Text style={settingsStyles.rowHint}>
              {t("settings.integrations.skills.chooseAllHint")}
            </Text>
          </View>
          <Switch
            value={allSkills}
            onValueChange={handleToggleAll}
            disabled={isSaving}
            accessibilityLabel={t("settings.integrations.skills.chooseAll")}
            testID="skill-selection-all"
          />
        </View>
      </View>

      <View style={styles.listGroup}>
        <Text style={settingsStyles.sectionTitle}>
          {t("settings.integrations.skills.chooseList")}
        </Text>
        <View style={settingsStyles.card}>
          {available.length === 0 ? (
            <View style={settingsStyles.row}>
              <Text style={settingsStyles.rowHint}>
                {t("settings.integrations.skills.chooseEmpty")}
              </Text>
            </View>
          ) : (
            available.map((name, index) => (
              <SkillCheckboxRow
                key={name}
                name={name}
                checked={isSkillSelected(draft, name)}
                disabled={allSkills || isSaving}
                withBorder={index > 0}
                onToggle={handleToggleSkill}
              />
            ))
          )}
        </View>
      </View>

      {saveError ? <Text style={settingsStyles.rowError}>{saveError}</Text> : null}
    </AdaptiveModalSheet>
  );
}

interface SkillCheckboxRowProps {
  name: string;
  checked: boolean;
  disabled: boolean;
  withBorder: boolean;
  onToggle: (name: string) => void;
}

function SkillCheckboxRow({
  name,
  checked,
  disabled,
  withBorder,
  onToggle,
}: SkillCheckboxRowProps) {
  const handlePress = useCallback(() => onToggle(name), [name, onToggle]);
  const accessibilityState = useMemo(() => ({ checked, disabled }), [checked, disabled]);
  const rowStyle = useMemo(
    () => [
      settingsStyles.row,
      withBorder ? settingsStyles.rowBorder : null,
      styles.checkboxRow,
      disabled ? styles.disabledRow : null,
    ],
    [disabled, withBorder],
  );
  const boxStyle = useMemo(
    () => [styles.checkbox, checked ? styles.checkboxChecked : null],
    [checked],
  );

  return (
    <Pressable
      style={rowStyle}
      onPress={handlePress}
      disabled={disabled}
      accessibilityRole="checkbox"
      accessibilityLabel={name}
      accessibilityState={accessibilityState}
      aria-checked={checked}
    >
      <View style={boxStyle}>
        {checked ? <ThemedCheck size={14} uniProps={checkedIconMapping} /> : null}
      </View>
      <Text style={settingsStyles.rowTitle}>{name}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  footer: {
    flex: 1,
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  footerButton: {
    flex: 1,
  },
  listGroup: {
    gap: theme.spacing[1],
  },
  checkboxRow: {
    justifyContent: "flex-start",
    gap: theme.spacing[3],
  },
  disabledRow: {
    opacity: theme.opacity[50],
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxChecked: {
    backgroundColor: theme.colors.accent,
    borderColor: theme.colors.accent,
  },
}));

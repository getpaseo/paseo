import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { SettingsCard, SettingsRow, SettingsSection } from "@/components/settings";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";
import type {
  AgentSkillSelection as SkillSelection,
  AgentSkillsSaveResult as SkillsSaveResult,
} from "@getpaseo/protocol/messages";

interface SkillSelectionSheetProps {
  visible: boolean;
  available: readonly string[];
  selection: SkillSelection;
  isSaving: boolean;
  onSave: (
    selection: SkillSelection,
    confirmedRemovals?: readonly string[],
  ) => Promise<SkillsSaveResult>;
  onClose: () => void;
}

function isSkillSelected(draft: SkillSelection, name: string): boolean {
  return draft.mode === "all" || draft.skills.includes(name);
}

/**
 * Draft form state only. The saved selection, the convergence across agent skill
 * directories, and the resulting status all belong to the selected host.
 */
export function SkillSelectionSheet({
  visible,
  available,
  selection,
  isSaving,
  onSave,
  onClose,
}: SkillSelectionSheetProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<SkillSelection>(selection);
  const [saveError, setSaveError] = useState<string | null>(null);
  const wasVisible = useRef(visible);

  // Seeded when the sheet opens, not whenever a background status refresh hands
  // back a new selection object — that would throw away edits in progress.
  useEffect(() => {
    const opening = visible && !wasVisible.current;
    wasVisible.current = visible;
    if (!opening) return;
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

  const handleSave = useCallback(() => {
    void (async () => {
      setSaveError(null);
      try {
        // The host refuses a save that would delete directories it was not told
        // about, and answers with the names it found when it looked. Asking it
        // is the only way the question and the deletion cannot drift apart.
        const attempt = await onSave(draft);
        if (attempt.confirmationRequired) {
          const confirmed = await confirmDialog({
            title: t("settings.host.skills.removeTitle"),
            message: t("settings.host.skills.removeMessage", {
              skills: attempt.confirmationRequired.removals.join(", "),
            }),
            confirmLabel: t("settings.host.skills.actions.remove"),
            destructive: true,
          });
          if (!confirmed) return;
          const retry = await onSave(draft, attempt.confirmationRequired.removals);
          // Something else changed the directories again while the dialog was
          // up. Ask about the new list rather than deleting it unannounced.
          if (retry.confirmationRequired) {
            setSaveError(t("settings.host.skills.saveFailed"));
            return;
          }
        }
        onClose();
      } catch {
        setSaveError(t("settings.host.skills.saveFailed"));
      }
    })();
  }, [draft, onClose, onSave, t]);

  const handleDismiss = useCallback(() => {
    if (isSaving) return;
    onClose();
  }, [isSaving, onClose]);

  const header = useMemo<SheetHeader>(() => ({ title: t("settings.host.skills.choose") }), [t]);

  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button
          style={styles.footerButton}
          variant="secondary"
          onPress={handleDismiss}
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
            ? t("settings.host.skills.actions.saving")
            : t("settings.host.skills.actions.save")}
        </Button>
      </View>
    ),
    [handleDismiss, handleSave, isSaving, t],
  );

  const allSkills = draft.mode === "all";

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={handleDismiss}
      footer={footer}
      testID="skill-selection-sheet"
    >
      <SettingsCard testID="skill-selection-all-card">
        <SettingsRow
          label={t("settings.host.skills.chooseAll")}
          hint={t("settings.host.skills.chooseAllHint")}
        >
          <Switch
            value={allSkills}
            onValueChange={handleToggleAll}
            disabled={isSaving}
            accessibilityLabel={t("settings.host.skills.chooseAll")}
            testID="skill-selection-all"
          />
        </SettingsRow>
      </SettingsCard>

      {/* The sheet body already spaces its blocks apart, so the section owns
          only the gap between its label and the list the label names. */}
      <SettingsSection title={t("settings.host.skills.chooseList")} flush>
        <SettingsCard testID="skill-selection-list-card">
          {available.length === 0 ? (
            <View style={settingsStyles.row}>
              <Text style={settingsStyles.rowHint}>{t("settings.host.skills.chooseEmpty")}</Text>
            </View>
          ) : (
            available.map((name) => (
              <SkillRow
                key={name}
                name={name}
                checked={isSkillSelected(draft, name)}
                disabled={allSkills || isSaving}
                onToggle={handleToggleSkill}
              />
            ))
          )}
        </SettingsCard>
      </SettingsSection>

      {saveError ? <Text style={settingsStyles.rowError}>{saveError}</Text> : null}
    </AdaptiveModalSheet>
  );
}

function SkillRow({
  name,
  checked,
  disabled,
  onToggle,
}: {
  name: string;
  checked: boolean;
  disabled: boolean;
  onToggle: (name: string) => void;
}) {
  const handleValueChange = useCallback(() => onToggle(name), [name, onToggle]);
  return (
    <SettingsRow label={name}>
      <Switch
        value={checked}
        onValueChange={handleValueChange}
        disabled={disabled}
        accessibilityLabel={name}
      />
    </SettingsRow>
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
}));

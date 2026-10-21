import { useCallback, useMemo, useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { FieldTrigger, type FieldTriggerVariant } from "./form/field-trigger";
import { newBranchIcon } from "./form/icons";

interface NewBranchFieldProps {
  variant: FieldTriggerVariant;
  pending: boolean;
  value: string;
  onChange: (value: string) => void;
}

interface BranchNameSheetProps {
  value: string;
  onSave: (value: string) => void;
  onClose: () => void;
}

const BRANCH_NAME_SNAP_POINTS = ["40%"];

function BranchNameSheet({ value, onSave, onClose }: BranchNameSheetProps) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [draft, setDraft] = useState(value);
  const size = isCompact ? "md" : "sm";
  const save = useCallback(() => onSave(draft.trim()), [draft, onSave]);
  const header = useMemo(() => ({ title: t("newWorkspace.fields.newBranchName") }), [t]);
  const footer = useMemo(
    () => (
      <View style={styles.actions}>
        <Button variant="secondary" size={size} onPress={onClose}>
          {t("common.actions.cancel")}
        </Button>
        <Button
          variant="default"
          size={size}
          onPress={save}
          testID="new-workspace-branch-name-save"
        >
          {t("common.actions.save")}
        </Button>
      </View>
    ),
    [onClose, save, size, t],
  );

  return (
    <AdaptiveModalSheet
      visible
      header={header}
      onClose={onClose}
      testID="new-workspace-branch-name-sheet"
      snapPoints={BRANCH_NAME_SNAP_POINTS}
      desktopMaxWidth={420}
      footer={footer}
    >
      <FormTextInput
        testID="new-workspace-branch-name"
        accessibilityLabel={t("newWorkspace.fields.newBranchName")}
        size={size}
        initialValue={value}
        onChangeText={setDraft}
        onSubmitEditing={save}
        placeholder={t("newWorkspace.fields.automaticBranchName")}
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="done"
      />
    </AdaptiveModalSheet>
  );
}

export function NewBranchField({ variant, pending, value, onChange }: NewBranchFieldProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const openEditor = useCallback(() => setOpen(true), []);
  const closeEditor = useCallback(() => setOpen(false), []);
  const save = useCallback(
    (name: string) => {
      onChange(name);
      setOpen(false);
    },
    [onChange],
  );

  return (
    <>
      <FieldTrigger
        variant={variant}
        label={t("newWorkspace.fields.newBranchName")}
        tooltip={t("newWorkspace.fields.newBranchName")}
        icon={newBranchIcon}
        value={value || t("newWorkspace.fields.automaticBranchName")}
        onPress={openEditor}
        disabled={pending}
        testID="new-workspace-branch-name-trigger"
      />
      {open ? <BranchNameSheet value={value} onSave={save} onClose={closeEditor} /> : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  actions: {
    flex: 1,
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));

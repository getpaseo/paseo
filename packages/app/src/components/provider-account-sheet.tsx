import { useCallback, useMemo, useSyncExternalStore, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Plus, X } from "lucide-react-native";
import type { MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useProviderAccountFormModel } from "@/provider-accounts/use-provider-account-form-model";
import type {
  ProviderAccountEnvRow,
  ProviderAccountFormModel,
  ProviderAccountFormState,
} from "@/provider-accounts/provider-account-form-model";
import type { Theme } from "@/styles/theme";

const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedX = withUnistyles(X, foregroundMutedColorMapping);
const ThemedPlus = withUnistyles(Plus, foregroundMutedColorMapping);
const ADD_VARIABLE_ICON = <ThemedPlus size={14} />;

export interface ProviderAccountCreateInput {
  providerId: string;
  patch: MutableDaemonConfigPatch;
}

export interface ProviderAccountSheetProps {
  visible: boolean;
  baseProviderId: string;
  baseProviderLabel: string;
  existingProviderIds: readonly string[];
  onClose: () => void;
  /** Resolves true when the account was written; the sheet then closes. */
  onCreate: (input: ProviderAccountCreateInput) => Promise<boolean>;
}

export function ProviderAccountSheet(props: ProviderAccountSheetProps): ReactElement | null {
  if (!props.visible) return null;
  return <OpenProviderAccountSheet {...props} />;
}

function OpenProviderAccountSheet({
  visible,
  baseProviderId,
  baseProviderLabel,
  existingProviderIds,
  onClose,
  onCreate,
}: ProviderAccountSheetProps): ReactElement {
  const { t } = useTranslation();
  const controlSize: FieldControlSize = useIsCompactFormFactor() ? "md" : "sm";
  const snapshot = useMemo(
    () => ({ baseProviderId, baseProviderLabel, existingProviderIds }),
    [baseProviderId, baseProviderLabel, existingProviderIds],
  );
  const model = useProviderAccountFormModel(snapshot);
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);

  const handleSubmit = useCallback(async () => {
    if (state.isSubmitting) return;
    model.markSubmitAttempted();
    const patch = model.buildPatch();
    if (!patch) return;

    model.setSubmitting(true);
    try {
      const created = await onCreate({ providerId: state.providerId.trim(), patch });
      if (created) {
        onClose();
        return;
      }
    } finally {
      model.setSubmitting(false);
    }
  }, [model, onClose, onCreate, state.isSubmitting, state.providerId]);

  const handleSubmitPress = useCallback(() => {
    void handleSubmit();
  }, [handleSubmit]);

  const header = useMemo<SheetHeader>(
    () => ({ title: t("settings.providers.account.title", { provider: baseProviderLabel }) }),
    [baseProviderLabel, t],
  );

  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button
          style={styles.footerButton}
          variant="secondary"
          onPress={onClose}
          disabled={state.isSubmitting}
          testID="provider-account-cancel"
        >
          {t("common.actions.cancel")}
        </Button>
        <Button
          style={styles.footerButton}
          variant="default"
          onPress={handleSubmitPress}
          disabled={state.isSubmitting}
          loading={state.isSubmitting}
          testID="provider-account-submit"
        >
          {t("settings.providers.account.submit")}
        </Button>
      </View>
    ),
    [handleSubmitPress, onClose, state.isSubmitting, t],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      footer={footer}
      testID="provider-account-sheet"
    >
      <Field
        label={t("settings.providers.account.fields.label")}
        error={state.labelError ? t("settings.providers.account.errors.labelRequired") : null}
        testID="provider-account-label"
      >
        <FormTextInput
          size={controlSize}
          testID="provider-account-label-input"
          accessibilityLabel={t("settings.providers.account.fields.label")}
          initialValue={state.label}
          value={state.label}
          onChangeText={model.setLabel}
          placeholder={t("settings.providers.account.placeholders.label", {
            provider: baseProviderLabel,
          })}
          autoCapitalize="words"
          autoCorrect={false}
          editable={!state.isSubmitting}
        />
      </Field>

      <Field
        label={t("settings.providers.account.fields.providerId")}
        error={resolveProviderIdError(state, t)}
        testID="provider-account-id"
      >
        <FormTextInput
          size={controlSize}
          testID="provider-account-id-input"
          accessibilityLabel={t("settings.providers.account.fields.providerId")}
          // The id mirrors the label until it is edited, so the uncontrolled
          // input has to remount whenever the derived value changes.
          initialValue={state.providerId}
          resetKey={state.providerIdEdited ? "manual" : `derived:${state.providerId}`}
          value={state.providerId}
          onChangeText={model.setProviderId}
          placeholder={t("settings.providers.account.placeholders.providerId")}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!state.isSubmitting}
        />
      </Field>

      <Field
        label={t("settings.providers.account.fields.description")}
        testID="provider-account-description"
      >
        <FormTextInput
          size={controlSize}
          testID="provider-account-description-input"
          accessibilityLabel={t("settings.providers.account.fields.description")}
          initialValue={state.description}
          value={state.description}
          onChangeText={model.setDescription}
          placeholder={t("settings.providers.account.placeholders.description")}
          autoCorrect={false}
          editable={!state.isSubmitting}
        />
      </Field>

      <Field label={t("settings.providers.account.fields.env")} testID="provider-account-env">
        <View style={styles.envRows}>
          {state.envRows.map((row, index) => (
            <EnvVarRow
              key={row.id}
              row={row}
              index={index}
              model={model}
              controlSize={controlSize}
              disabled={state.isSubmitting}
              error={resolveEnvError(state, row, t)}
            />
          ))}
          <Button
            variant="ghost"
            size={controlSize === "md" ? "md" : "sm"}
            style={styles.addEnvButton}
            onPress={model.addEnvRow}
            disabled={state.isSubmitting}
            leftIcon={ADD_VARIABLE_ICON}
            testID="provider-account-env-add"
          >
            {t("settings.providers.account.actions.addVariable")}
          </Button>
        </View>
      </Field>
    </AdaptiveModalSheet>
  );
}

type Translate = ReturnType<typeof useTranslation>["t"];

function resolveProviderIdError(state: ProviderAccountFormState, t: Translate): string | null {
  switch (state.providerIdError) {
    case "required":
      return t("settings.providers.account.errors.idRequired");
    case "invalid":
      return t("settings.providers.account.errors.idInvalid");
    case "taken":
      return t("settings.providers.account.errors.idTaken");
    default:
      return null;
  }
}

function resolveEnvError(
  state: ProviderAccountFormState,
  row: ProviderAccountEnvRow,
  t: Translate,
): string | null {
  switch (state.envErrors[row.id]) {
    case "keyRequired":
      return t("settings.providers.account.errors.envKeyRequired");
    case "duplicate":
      return t("settings.providers.account.errors.envDuplicate");
    default:
      return null;
  }
}

interface EnvVarRowProps {
  row: ProviderAccountEnvRow;
  index: number;
  model: ProviderAccountFormModel;
  controlSize: FieldControlSize;
  disabled: boolean;
  error: string | null;
}

function EnvVarRow({
  row,
  index,
  model,
  controlSize,
  disabled,
  error,
}: EnvVarRowProps): ReactElement {
  const { t } = useTranslation();
  const handleKeyChange = useCallback(
    (value: string) => {
      model.setEnvKey(row.id, value);
    },
    [model, row.id],
  );
  const handleValueChange = useCallback(
    (value: string) => {
      model.setEnvValue(row.id, value);
    },
    [model, row.id],
  );
  const handleRemove = useCallback(() => {
    model.removeEnvRow(row.id);
  }, [model, row.id]);

  return (
    <View style={styles.envRowGroup}>
      <View style={styles.envRow}>
        <View style={styles.envKeyField}>
          <FormTextInput
            size={controlSize}
            testID={`provider-account-env-key-${index}`}
            accessibilityLabel={t("settings.providers.account.fields.envKey")}
            initialValue={row.key}
            value={row.key}
            onChangeText={handleKeyChange}
            placeholder={t("settings.providers.account.placeholders.envKey")}
            autoCapitalize="characters"
            autoCorrect={false}
            editable={!disabled}
          />
        </View>
        <View style={styles.envValueField}>
          <FormTextInput
            size={controlSize}
            testID={`provider-account-env-value-${index}`}
            accessibilityLabel={t("settings.providers.account.fields.envValue")}
            initialValue={row.value}
            value={row.value}
            onChangeText={handleValueChange}
            placeholder={t("settings.providers.account.placeholders.envValue")}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!disabled}
          />
        </View>
        <Pressable
          style={styles.envRemoveButton}
          onPress={handleRemove}
          disabled={disabled}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t("settings.providers.account.actions.removeVariable")}
          testID={`provider-account-env-remove-${index}`}
        >
          <ThemedX size={14} />
        </Pressable>
      </View>
      {error ? <Text style={styles.envRowError}>{error}</Text> : null}
    </View>
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
  envRows: {
    gap: theme.spacing[2],
  },
  envRowGroup: {
    gap: theme.spacing[1],
  },
  envRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  envKeyField: {
    flex: 1,
    minWidth: 0,
  },
  envValueField: {
    flex: 1,
    minWidth: 0,
  },
  envRemoveButton: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.lg,
  },
  envRowError: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.xs,
    lineHeight: Math.round(theme.fontSize.xs * 1.4),
  },
  addEnvButton: {
    alignSelf: "flex-start",
  },
}));

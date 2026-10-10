import { supportsSshKeyImport } from "@/hosts/ssh/ssh-transport";
import { useRemoteSshFormModel } from "@/hosts/ssh/use-remote-ssh-form-model";
import { SshKeyImportFields } from "./ssh-key-import-fields";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import {
  Pressable,
  Text,
  View,
  type PressableStateCallbackType,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Eye, EyeOff, Terminal } from "lucide-react-native";
import type { HostProfile } from "@/types/host-connection";
import type { HostMutations } from "@/runtime/host-runtime";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import {
  CONTROL_HEIGHTS,
  createControlGeometry,
  resolveControlInteractionStyles,
} from "@/components/ui/control-geometry";
import { useIsCompactFormFactor } from "@/constants/layout";
import { AdaptiveModalSheet, type SheetHeader } from "./adaptive-modal-sheet";

const FLEX_ONE_STYLE = { flex: 1 } as const;
const ThemedTerminal = withUnistyles(Terminal);
const ThemedEye = withUnistyles(Eye, (theme) => ({ color: theme.colors.foregroundMuted }));
const ThemedEyeOff = withUnistyles(EyeOff, (theme) => ({ color: theme.colors.foregroundMuted }));

const styles = StyleSheet.create((theme) => {
  const geometry = createControlGeometry(theme);
  return {
    helper: {
      color: theme.colors.foregroundMuted,
      fontSize: theme.fontSize.sm,
    },
    passwordRow: {
      flexDirection: "row",
      alignItems: "center",
      alignSelf: "stretch",
      width: "100%",
      gap: theme.spacing[2],
    },
    passwordInputWrap: {
      flex: 1,
      minWidth: 0,
    },
    // Boxed adornment next to the field: same height and radius as the field
    // chrome of the active form size, and the shared interaction phases.
    iconButtonSm: {
      minHeight: CONTROL_HEIGHTS.compact,
      width: CONTROL_HEIGHTS.compact,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: theme.borderRadius.md,
      backgroundColor: theme.colors.surface2,
    },
    iconButtonMd: {
      minHeight: CONTROL_HEIGHTS.field,
      width: CONTROL_HEIGHTS.field,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: theme.borderRadius.lg,
      backgroundColor: theme.colors.surface2,
    },
    controlRest: {
      ...geometry.controlRest,
    },
    controlHover: {
      ...geometry.controlHover,
    },
    controlActive: {
      ...geometry.controlActive,
    },
    controlDisabled: {
      ...geometry.controlDisabled,
    },
    actions: {
      flexDirection: "row",
      gap: theme.spacing[3],
      marginTop: theme.spacing[2],
    },
  };
});

export interface AddRemoteSshHostModalProps {
  visible: boolean;
  onClose: () => void;
  onCancel?: () => void;
  onSaved?: (result: {
    profile: HostProfile;
    serverId: string;
    hostname: string | null;
    isNewHost: boolean;
  }) => void;
}

interface RemoteSshHostFormProps extends AddRemoteSshHostModalProps {
  hosts: HostProfile[];
  probeAndUpsertRemoteSshConnection: HostMutations["probeAndUpsertRemoteSshConnection"];
}

/** Destroy the open form on every dismissal, including Android Back and pan-down. */
export function RemoteSshHostForm(props: RemoteSshHostFormProps) {
  if (!props.visible) return null;
  return <OpenRemoteSshHostForm {...props} />;
}

/** Render form state and dispatch intent; the model owns credentials and async work. */
function OpenRemoteSshHostForm({
  onClose,
  onCancel,
  onSaved,
  hosts,
  probeAndUpsertRemoteSshConnection,
}: RemoteSshHostFormProps) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const model = useRemoteSshFormModel(probeAndUpsertRemoteSshConnection);
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const { keyName, fingerprint, isPasswordVisible } = state;
  const isSaving = state.phase !== "idle";
  const header = useMemo<SheetHeader>(() => ({ title: t("pairing.remoteSsh.title") }), [t]);
  let errorMessage = "";
  if (state.error) {
    switch (state.error.kind) {
      case "targetRequired":
        errorMessage = t("pairing.remoteSsh.errors.targetRequired");
        break;
      case "invalidTarget":
        errorMessage = t("pairing.remoteSsh.errors.invalidTarget");
        break;
      case "keyRequired":
        errorMessage = t("pairing.remoteSsh.keyImport.required");
        break;
      case "unableToSave":
        errorMessage = t("common.errors.unableToSave");
        break;
      case "connectionFailed":
        errorMessage = t("pairing.remoteSsh.errors.failedToConnect", {
          detail: state.error.detail,
        });
        break;
      case "importFailed":
        errorMessage = state.error.detail;
        break;
    }
  }
  const handleClose = useCallback(() => {
    model.close();
    onClose();
  }, [model, onClose]);
  const handleCancel = useCallback(() => {
    model.close();
    (onCancel ?? onClose)();
  }, [model, onCancel, onClose]);
  const handleSubmit = useCallback(async () => {
    const result = await model.submit();
    if (!result) return;
    model.close();
    onClose();
    onSaved?.({
      ...result,
      isNewHost: !hosts.some((profile) => profile.serverId === result.serverId),
    });
  }, [hosts, model, onClose, onSaved]);
  const handleImport = useCallback(() => {
    void model.importKey();
  }, [model]);
  const iconButtonStyle = useCallback(
    (
      interaction: PressableStateCallbackType & { hovered?: boolean; focused?: boolean },
    ): StyleProp<ViewStyle> => [
      isCompact ? styles.iconButtonMd : styles.iconButtonSm,
      resolveControlInteractionStyles(
        {
          controlRest: styles.controlRest,
          controlHover: styles.controlHover,
          controlActive: styles.controlActive,
          controlDisabled: styles.controlDisabled,
        },
        {
          hovered: interaction.hovered,
          pressed: interaction.pressed,
          focused: interaction.focused,
          disabled: isSaving,
        },
      ),
    ],
    [isCompact, isSaving],
  );
  let submitLabel = t("pairing.remoteSsh.actions.connect");
  if (fingerprint) submitLabel = t("pairing.remoteSsh.keyImport.trustAndConnect");
  if (isSaving) submitLabel = t("pairing.remoteSsh.actions.connecting");

  return (
    <AdaptiveModalSheet
      header={header}
      visible
      onClose={handleClose}
      testID="add-remote-ssh-host-modal"
    >
      <Text style={styles.helper}>{t("pairing.remoteSsh.helper")}</Text>
      <Field
        label={t("pairing.remoteSsh.fields.target")}
        error={errorMessage}
        testID="remote-ssh-target"
      >
        <FormTextInput
          size={isCompact ? "md" : "sm"}
          testID="remote-ssh-target-input"
          accessibilityLabel={t("pairing.remoteSsh.fields.target")}
          initialValue=""
          onChangeText={model.setTarget}
          placeholder="ssh://user@host"
          autoCapitalize="none"
          autoCorrect={false}
          editable={!isSaving}
          returnKeyType="done"
          onSubmitEditing={handleSubmit}
        />
      </Field>
      {supportsSshKeyImport ? (
        <SshKeyImportFields
          keyName={keyName}
          fingerprint={fingerprint}
          disabled={isSaving}
          onImport={handleImport}
          onPassphraseChange={model.setPassphrase}
        />
      ) : null}
      <Field label={t("pairing.remoteSsh.fields.password")} testID="remote-ssh-password">
        <View style={styles.passwordRow}>
          <View style={styles.passwordInputWrap}>
            <FormTextInput
              size={isCompact ? "md" : "sm"}
              testID="remote-ssh-password-input"
              accessibilityLabel={t("pairing.remoteSsh.fields.password")}
              initialValue=""
              onChangeText={model.setPassword}
              placeholder={t("pairing.remoteSsh.fields.optional")}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry={!isPasswordVisible}
              editable={!isSaving}
              returnKeyType="done"
              onSubmitEditing={handleSubmit}
            />
          </View>
          <Pressable
            style={iconButtonStyle}
            onPress={model.togglePasswordVisibility}
            disabled={isSaving}
            accessibilityRole="button"
            accessibilityLabel={
              isPasswordVisible
                ? t("pairing.remoteSsh.passwordVisibility.hide")
                : t("pairing.remoteSsh.passwordVisibility.show")
            }
            testID="remote-ssh-password-visibility-toggle"
          >
            {isPasswordVisible ? <ThemedEyeOff size={18} /> : <ThemedEye size={18} />}
          </Pressable>
        </View>
      </Field>
      <View style={styles.actions}>
        <Button style={FLEX_ONE_STYLE} variant="secondary" onPress={handleCancel}>
          {t("pairing.remoteSsh.actions.cancel")}
        </Button>
        <Button
          style={FLEX_ONE_STYLE}
          onPress={handleSubmit}
          disabled={isSaving}
          leftIcon={ThemedTerminal}
          testID="remote-ssh-submit"
        >
          {submitLabel}
        </Button>
      </View>
    </AdaptiveModalSheet>
  );
}

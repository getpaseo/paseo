import { PressHighlight } from "@/components/ui/press-highlight";
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Text,
  View,
  type PressableStateCallbackType,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Eye, EyeOff, Terminal } from "lucide-react-native";
import { parseRemoteHostInput, type RemoteHostMethod } from "./model";
import type { HostProfile } from "@/types/host-connection";
import { useHostMutations, useHosts } from "@/runtime/host-runtime";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import {
  CONTROL_HEIGHTS,
  createControlGeometry,
  resolveControlInteractionStyles,
} from "@/components/ui/control-geometry";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { DaemonConnectionTestError } from "@/utils/test-daemon-connection";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";

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
    // chrome, and the shared interaction phases.
    iconButton: {
      minHeight: CONTROL_HEIGHTS.md,
      width: CONTROL_HEIGHTS.md,
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

interface AddRemoteHostModalProps {
  method: RemoteHostMethod;
  onClose: () => void;
  onCancel?: () => void;
  onSaved?: (result: {
    profile: HostProfile;
    serverId: string;
    hostname: string | null;
    isNewHost: boolean;
  }) => void;
}

export function AddRemoteHostModal({
  method,
  onClose,
  onCancel,
  onSaved,
}: AddRemoteHostModalProps) {
  const { t } = useTranslation();
  const hosts = useHosts();
  const { probeAndUpsertRemoteSshConnection, probeAndUpsertRemoteEtConnection } =
    useHostMutations();
  const targetRef = useRef("");
  const passwordRef = useRef("");
  const inputRef = useRef<EditingTextInputHandle>(null);
  const passwordInputRef = useRef<EditingTextInputHandle>(null);
  const [isPasswordVisible, setIsPasswordVisible] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const translation = method === "et" ? "pairing.remoteEt" : "pairing.remoteSsh";
  const title =
    method === "et" ? "pairing.connectionMethods.remoteEt.title" : "pairing.remoteSsh.title";
  const testIdPrefix = `remote-${method}`;
  const header = useMemo<SheetHeader>(() => ({ title: t(title) }), [t, title]);

  const clear = useCallback(() => {
    targetRef.current = "";
    passwordRef.current = "";
    inputRef.current?.replaceText("");
    passwordInputRef.current?.replaceText("");
    setIsPasswordVisible(false);
    setErrorMessage("");
  }, []);

  const handleClose = useCallback(() => {
    if (isSaving) return;
    clear();
    onClose();
  }, [clear, isSaving, onClose]);

  const handleCancel = useCallback(() => {
    if (isSaving) return;
    clear();
    (onCancel ?? onClose)();
  }, [clear, isSaving, onCancel, onClose]);

  const handleSave = useCallback(async () => {
    if (isSaving) return;
    const rawTarget = targetRef.current.trim();
    if (!rawTarget) {
      setErrorMessage(t(`${translation}.errors.targetRequired`));
      return;
    }

    let input: ReturnType<typeof parseRemoteHostInput>;
    try {
      input = parseRemoteHostInput(method, rawTarget, passwordRef.current);
    } catch {
      setErrorMessage(t(`${translation}.errors.invalidTarget`));
      return;
    }

    let result: Awaited<ReturnType<typeof probeAndUpsertRemoteSshConnection>>;
    try {
      setIsSaving(true);
      setErrorMessage("");
      result =
        input.method === "et"
          ? await probeAndUpsertRemoteEtConnection(input.target)
          : await probeAndUpsertRemoteSshConnection(input.target);
    } catch (error) {
      const message =
        error instanceof DaemonConnectionTestError
          ? t(`${translation}.errors.failedToConnect`, { detail: error.message })
          : t("common.errors.unableToSave");
      setErrorMessage(message);
      return;
    } finally {
      setIsSaving(false);
    }

    clear();
    onSaved?.({
      ...result,
      isNewHost: !hosts.some((profile) => profile.serverId === result.serverId),
    });
    onClose();
  }, [
    clear,
    hosts,
    isSaving,
    method,
    onClose,
    onSaved,
    probeAndUpsertRemoteEtConnection,
    probeAndUpsertRemoteSshConnection,
    t,
    translation,
  ]);
  const handleTargetChange = useCallback((value: string) => {
    targetRef.current = value;
  }, []);
  const handlePasswordChange = useCallback((value: string) => {
    passwordRef.current = value;
  }, []);
  const handleTogglePasswordVisibility = useCallback(() => {
    setIsPasswordVisible((currentlyVisible) => !currentlyVisible);
  }, []);
  const iconButtonStyle = useCallback(
    (
      state: PressableStateCallbackType & { hovered?: boolean; focused?: boolean },
    ): StyleProp<ViewStyle> => [
      styles.iconButton,
      resolveControlInteractionStyles(
        {
          controlRest: styles.controlRest,
          controlHover: styles.controlHover,
          controlActive: styles.controlActive,
          controlDisabled: styles.controlDisabled,
        },
        {
          hovered: state.hovered,
          pressed: state.pressed,
          focused: state.focused,
          disabled: isSaving,
        },
      ),
    ],
    [isSaving],
  );
  const handleSubmit = useCallback(() => void handleSave(), [handleSave]);

  return (
    <AdaptiveModalSheet
      header={header}
      visible
      onClose={handleClose}
      testID={`add-${testIdPrefix}-host-modal`}
    >
      <Text style={styles.helper}>{t("pairing.remoteSsh.helper")}</Text>
      <Field
        label={t(`${translation}.fields.target`)}
        error={errorMessage}
        testID={`${testIdPrefix}-target`}
      >
        <FormTextInput
          ref={inputRef}
          testID={`${testIdPrefix}-target-input`}
          accessibilityLabel={t(`${translation}.fields.target`)}
          initialValue=""
          onChangeText={handleTargetChange}
          placeholder={`${method}://user@host`}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!isSaving}
          returnKeyType="done"
          onSubmitEditing={handleSubmit}
        />
      </Field>
      <Field label={t(`${translation}.fields.password`)} testID={`${testIdPrefix}-password`}>
        <View style={styles.passwordRow}>
          <View style={styles.passwordInputWrap}>
            <FormTextInput
              ref={passwordInputRef}
              testID={`${testIdPrefix}-password-input`}
              accessibilityLabel={t(`${translation}.fields.password`)}
              initialValue=""
              onChangeText={handlePasswordChange}
              placeholder={t("pairing.remoteSsh.fields.optional")}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry={!isPasswordVisible}
              editable={!isSaving}
              returnKeyType="done"
              onSubmitEditing={handleSubmit}
            />
          </View>
          <PressHighlight
            style={iconButtonStyle}
            onPress={handleTogglePasswordVisibility}
            disabled={isSaving}
            accessibilityRole="button"
            accessibilityLabel={
              isPasswordVisible
                ? t("pairing.remoteSsh.passwordVisibility.hide")
                : t("pairing.remoteSsh.passwordVisibility.show")
            }
            testID={`${testIdPrefix}-password-visibility-toggle`}
          >
            {isPasswordVisible ? <ThemedEyeOff size={18} /> : <ThemedEye size={18} />}
          </PressHighlight>
        </View>
      </Field>
      <View style={styles.actions}>
        <Button
          style={FLEX_ONE_STYLE}
          variant="secondary"
          onPress={handleCancel}
          disabled={isSaving}
        >
          {t("pairing.remoteSsh.actions.cancel")}
        </Button>
        <Button
          style={FLEX_ONE_STYLE}
          onPress={handleSubmit}
          disabled={isSaving}
          leftIcon={ThemedTerminal}
          testID={`${testIdPrefix}-submit`}
        >
          {isSaving
            ? t("pairing.remoteSsh.actions.connecting")
            : t("pairing.remoteSsh.actions.connect")}
        </Button>
      </View>
    </AdaptiveModalSheet>
  );
}

import { ChevronRight } from "lucide-react-native";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  AdaptiveModalSheet,
  AdaptiveTextInput,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { Button } from "@/components/ui/button";
import { useHostMutations } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import type { HostProfile } from "@/types/host-connection";

const ThemedChevronRight = withUnistyles(ChevronRight);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/** One row showing whether a password is saved; tapping it opens the password modal. */
export function HostPasswordSection({ host }: { host: HostProfile }) {
  const { t } = useTranslation();
  const [isEditing, setIsEditing] = useState(false);
  const openEditor = useCallback(() => setIsEditing(true), []);
  const closeEditor = useCallback(() => setIsEditing(false), []);

  return (
    <SettingsSection title={t("settings.host.password.title")}>
      <View style={settingsStyles.card}>
        <Pressable
          style={settingsStyles.row}
          onPress={openEditor}
          accessibilityRole="button"
          testID="host-password-row"
        >
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("settings.host.password.label")}</Text>
          </View>
          <Text style={styles.status} testID="host-password-row-status">
            {t(host.password ? "settings.host.password.saved" : "settings.host.password.unset")}
          </Text>
          <ThemedChevronRight size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
        </Pressable>
      </View>
      {isEditing ? <HostPasswordModal host={host} onClose={closeEditor} /> : null}
    </SettingsSection>
  );
}

/** Mount only while open, so every open starts with an empty field. */
export function HostPasswordModal({ host, onClose }: { host: HostProfile; onClose: () => void }) {
  const { t } = useTranslation();
  const { setHostPassword } = useHostMutations();
  const [password, setPassword] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const header = useMemo<SheetHeader>(
    () => ({ title: t("settings.host.password.modalTitle") }),
    [t],
  );

  const save = useCallback(
    async (nextPassword: string) => {
      setIsSaving(true);
      setError(null);
      try {
        await setHostPassword(host.serverId, nextPassword);
        onClose();
      } catch (cause) {
        setIsSaving(false);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [host.serverId, onClose, setHostPassword],
  );

  const canSave = !isSaving && password.length > 0;
  const handleSave = useCallback(() => {
    if (canSave) void save(password);
  }, [canSave, password, save]);
  const handleClear = useCallback(() => void save(""), [save]);
  const handleClose = useCallback(() => {
    if (!isSaving) onClose();
  }, [isSaving, onClose]);

  return (
    <AdaptiveModalSheet header={header} visible onClose={handleClose} testID="host-password-modal">
      <View style={styles.body}>
        <AdaptiveTextInput
          testID="host-password-modal-input"
          accessibilityLabel={t("settings.host.password.label")}
          onChangeText={setPassword}
          onSubmitEditing={handleSave}
          secureTextEntry
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          editable={!isSaving}
          style={styles.input}
        />
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        <View style={styles.actions}>
          {host.password ? (
            <Button
              variant="secondary"
              size="sm"
              style={styles.actionButton}
              onPress={handleClear}
              disabled={isSaving}
              testID="host-password-modal-clear"
            >
              {t("settings.host.password.clear")}
            </Button>
          ) : null}
          <Button
            variant="default"
            size="sm"
            style={styles.actionButton}
            onPress={handleSave}
            disabled={!canSave}
            testID="host-password-modal-save"
          >
            {isSaving ? t("settings.host.password.saving") : t("settings.host.password.save")}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  status: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  body: {
    gap: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  input: {
    backgroundColor: theme.colors.surface0,
    color: theme.colors.foreground,
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    fontSize: theme.fontSize.base,
  },
  errorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.base,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  actionButton: {
    flex: 1,
  },
}));

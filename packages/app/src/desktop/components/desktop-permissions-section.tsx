import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { View, Text, type PressableStateCallbackType } from "react-native";
import { StyleSheet, useUnistyles, withUnistyles } from "react-native-unistyles";
import { ChevronDown, RotateCw } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DesktopPermissionRow } from "@/desktop/components/desktop-permission-row";
import { useDesktopPermissions } from "@/desktop/permissions/use-desktop-permissions";
import {
  ATTENTION_SOUND_PRESETS,
  useAppSettings,
  type AttentionSoundPreset,
} from "@/hooks/use-settings";
import { playAttentionSound } from "@/utils/attention-sound";
import { settingsStyles } from "@/styles/settings";
import { SettingsSection } from "@/screens/settings/settings-section";
import type { Theme } from "@/styles/theme";
import { ICON_SIZE } from "@/styles/theme";

const ThemedChevronDown = withUnistyles(ChevronDown);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function dropdownTriggerStyle({
  pressed = false,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.trigger, pressed ? styles.triggerPressed : null];
}

function attentionPresetLabelKey(preset: AttentionSoundPreset): string {
  return `settings.permissions.attention.preset.${preset}`;
}

export function DesktopPermissionsSection() {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const { settings, updateSettings } = useAppSettings();
  const {
    isDesktopApp,
    snapshot,
    isRefreshing,
    requestingPermission,
    isSendingTestNotification,
    testNotificationError,
    refreshPermissions,
    requestPermission,
    sendTestNotification,
  } = useDesktopPermissions();

  const errorTextStyle = useMemo(
    () => [styles.errorText, { color: theme.colors.destructive }],
    [theme.colors.destructive],
  );

  const handleRefreshPress = useCallback(() => {
    void refreshPermissions();
  }, [refreshPermissions]);

  const handleRequestNotifications = useCallback(() => {
    void requestPermission("notifications");
  }, [requestPermission]);

  const handleRequestMicrophone = useCallback(() => {
    void requestPermission("microphone");
  }, [requestPermission]);

  const handleSendTestNotification = useCallback(() => {
    void sendTestNotification();
  }, [sendTestNotification]);

  const handleIntrusiveChange = useCallback(
    (value: boolean) => {
      void updateSettings({ attentionIntrusiveMode: value });
    },
    [updateSettings],
  );

  const handleBubbleChange = useCallback(
    (value: boolean) => {
      void updateSettings({ attentionOsBubbleEnabled: value });
    },
    [updateSettings],
  );

  const handleSoundChange = useCallback(
    (value: boolean) => {
      void updateSettings({ attentionSoundEnabled: value });
    },
    [updateSettings],
  );

  const handlePresetChange = useCallback(
    (value: AttentionSoundPreset) => {
      void updateSettings({ attentionSoundPreset: value });
      // Preview on select so the user can hear before saving preference matters.
      playAttentionSound(value);
    },
    [updateSettings],
  );

  const presetSelectHandlers = useMemo(() => {
    const handlers = {} as Record<AttentionSoundPreset, () => void>;
    for (const preset of ATTENTION_SOUND_PRESETS) {
      handlers[preset] = () => handlePresetChange(preset);
    }
    return handlers;
  }, [handlePresetChange]);

  const selectedPresetLabel = t(attentionPresetLabelKey(settings.attentionSoundPreset));

  const isBusy = isRefreshing || requestingPermission !== null;
  const notificationsGranted = snapshot?.notifications.state === "granted";

  const refreshIcon = useMemo(
    () => <RotateCw size={theme.iconSize.md} color={theme.colors.foregroundMuted} />,
    [theme.iconSize.md, theme.colors.foregroundMuted],
  );

  const refreshButton = useMemo(
    () => (
      <Button
        variant="ghost"
        size="sm"
        leftIcon={refreshIcon}
        onPress={handleRefreshPress}
        disabled={isBusy}
        accessibilityLabel={t("settings.permissions.refreshAccessibility")}
      >
        {isRefreshing ? t("settings.permissions.refreshing") : t("settings.permissions.refresh")}
      </Button>
    ),
    [refreshIcon, handleRefreshPress, isBusy, isRefreshing, t],
  );

  const permissionLabels = useMemo(
    () => ({
      granted: t("settings.permissions.actions.granted"),
      request: t("settings.permissions.actions.request"),
      requesting: t("settings.permissions.actions.requesting"),
      busyExtraAction: (label: string) => t("settings.permissions.actions.busySuffix", { label }),
    }),
    [t],
  );

  if (!isDesktopApp) {
    return null;
  }

  return (
    <>
      <SettingsSection title={t("settings.permissions.title")} trailing={refreshButton}>
        <View style={settingsStyles.card}>
          <DesktopPermissionRow
            title={t("settings.permissions.notifications")}
            status={snapshot?.notifications ?? null}
            isRequesting={requestingPermission === "notifications"}
            onRequest={handleRequestNotifications}
            labels={permissionLabels}
            extraActionLabel={t("settings.permissions.test")}
            isExtraActionBusy={isSendingTestNotification}
            isExtraActionDisabled={!notificationsGranted || isBusy}
            onExtraAction={handleSendTestNotification}
          />
          {testNotificationError ? (
            <Text style={errorTextStyle}>{testNotificationError}</Text>
          ) : null}
          <DesktopPermissionRow
            title={t("settings.permissions.microphone")}
            showBorder
            status={snapshot?.microphone ?? null}
            isRequesting={requestingPermission === "microphone"}
            onRequest={handleRequestMicrophone}
            labels={permissionLabels}
          />
        </View>
      </SettingsSection>

      <SettingsSection title={t("settings.permissions.attention.title")}>
        <View style={settingsStyles.card}>
          <View style={settingsStyles.row}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>
                {t("settings.permissions.attention.intrusive.label")}
              </Text>
              <Text style={settingsStyles.rowHint}>
                {t("settings.permissions.attention.intrusive.description")}
              </Text>
            </View>
            <Switch
              value={settings.attentionIntrusiveMode}
              onValueChange={handleIntrusiveChange}
              accessibilityLabel={t("settings.permissions.attention.intrusive.label")}
              testID="attention-intrusive-switch"
            />
          </View>
          <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>
                {t("settings.permissions.attention.bubble.label")}
              </Text>
              <Text style={settingsStyles.rowHint}>
                {t("settings.permissions.attention.bubble.description")}
              </Text>
            </View>
            <Switch
              value={settings.attentionOsBubbleEnabled}
              onValueChange={handleBubbleChange}
              accessibilityLabel={t("settings.permissions.attention.bubble.label")}
              testID="attention-bubble-switch"
            />
          </View>
          <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>
                {t("settings.permissions.attention.sound.label")}
              </Text>
              <Text style={settingsStyles.rowHint}>
                {t("settings.permissions.attention.sound.description")}
              </Text>
            </View>
            <Switch
              value={settings.attentionSoundEnabled}
              onValueChange={handleSoundChange}
              accessibilityLabel={t("settings.permissions.attention.sound.label")}
              testID="attention-sound-switch"
            />
          </View>
          <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>
                {t("settings.permissions.attention.preset.label")}
              </Text>
              <Text style={settingsStyles.rowHint}>
                {t("settings.permissions.attention.preset.description")}
              </Text>
            </View>
            <DropdownMenu>
              <DropdownMenuTrigger
                style={dropdownTriggerStyle}
                accessibilityLabel={t("settings.permissions.attention.preset.accessibilityLabel", {
                  value: selectedPresetLabel,
                })}
                testID="attention-sound-preset"
              >
                <Text style={styles.triggerText} numberOfLines={1}>
                  {selectedPresetLabel}
                </Text>
                <ThemedChevronDown size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side="bottom"
                align="end"
                width={220}
                testID="attention-sound-preset-menu"
              >
                {ATTENTION_SOUND_PRESETS.map((preset) => (
                  <DropdownMenuItem
                    key={preset}
                    selected={settings.attentionSoundPreset === preset}
                    onSelect={presetSelectHandlers[preset]}
                    testID={`attention-sound-preset-${preset}`}
                  >
                    {t(attentionPresetLabelKey(preset))}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </View>
        </View>
      </SettingsSection>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  errorText: {
    fontSize: theme.fontSize.xs,
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[2],
  },
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    maxWidth: 180,
  },
  triggerPressed: {
    backgroundColor: theme.colors.surface2,
  },
  triggerText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
  },
}));

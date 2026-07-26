import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { View, Text } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { RotateCw } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { DesktopPermissionRow } from "@/desktop/components/desktop-permission-row";
import { useDesktopPermissions } from "@/desktop/permissions/use-desktop-permissions";
import { useAppSettings, type AttentionSoundPreset } from "@/hooks/use-settings";
import { settingsStyles } from "@/styles/settings";
import { SettingsSection } from "@/screens/settings/settings-section";

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
    },
    [updateSettings],
  );

  const presetOptions = useMemo(
    () => [
      {
        value: "soft" as const,
        label: t("settings.permissions.attention.preset.soft"),
        testID: "attention-sound-preset-soft",
      },
      {
        value: "ping" as const,
        label: t("settings.permissions.attention.preset.ping"),
        testID: "attention-sound-preset-ping",
      },
      {
        value: "classic" as const,
        label: t("settings.permissions.attention.preset.classic"),
        testID: "attention-sound-preset-classic",
      },
    ],
    [t],
  );

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
            <SegmentedControl
              options={presetOptions}
              value={settings.attentionSoundPreset}
              onValueChange={handlePresetChange}
              size="xs"
              style={styles.presetControl}
              testID="attention-sound-preset"
            />
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
  presetControl: {
    maxWidth: 220,
  },
}));

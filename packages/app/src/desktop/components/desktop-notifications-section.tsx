import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { RotateCw } from "lucide-react-native";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { DesktopPermissionRow } from "@/desktop/components/desktop-permission-row";
import { getDesktopHost } from "@/desktop/host";
import { useDesktopPermissions } from "@/desktop/permissions/use-desktop-permissions";
import { useDesktopSettings } from "@/desktop/settings/desktop-settings";
import { SettingsSection } from "@/screens/settings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { resetCustomNotificationSound } from "@/utils/os-notifications";

const ThemedRotateCw = withUnistyles(RotateCw, (theme) => ({
  size: theme.iconSize.md,
  color: theme.colors.foregroundMuted,
}));

const CUSTOM_SOUND_EXTENSIONS = ["mp3", "wav", "m4a", "aac", "ogg", "flac", "aiff"];

function getFileName(filePath: string): string {
  const segments = filePath.split(/[\\/]/);
  return segments[segments.length - 1] || filePath;
}

const styles = StyleSheet.create((theme) => ({
  customSoundActions: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing[2],
  },
}));

export function DesktopNotificationsSection() {
  const { t } = useTranslation();
  const { settings, isSaving, updateSettings } = useDesktopSettings();
  const [isChoosingSound, setIsChoosingSound] = useState(false);
  const {
    isDesktopApp,
    snapshot,
    isRefreshing,
    requestingPermission,
    testNotificationState,
    refreshPermissions,
    requestPermission,
    sendTestNotification,
  } = useDesktopPermissions();

  const handleRefreshPress = useCallback(() => {
    void refreshPermissions();
  }, [refreshPermissions]);

  const handleRequestNotifications = useCallback(() => {
    void requestPermission("notifications");
  }, [requestPermission]);

  const handlePlaySoundChange = useCallback(
    (playSound: boolean) => {
      resetCustomNotificationSound();
      void updateSettings({ notifications: { playSound } }).catch(() => {
        // useDesktopSettings owns the user-visible IPC error.
      });
    },
    [updateSettings],
  );

  const handleChooseCustomSound = useCallback(async () => {
    const open = getDesktopHost()?.dialog?.open;
    if (typeof open !== "function") {
      return;
    }

    setIsChoosingSound(true);
    try {
      const selection = await open({
        title: t("settings.notifications.customSound"),
        multiple: false,
        filters: [
          {
            name: t("settings.notifications.customSoundFilter"),
            extensions: CUSTOM_SOUND_EXTENSIONS,
          },
        ],
      }).catch(() => null);
      if (typeof selection !== "string") {
        return;
      }

      resetCustomNotificationSound();
      await updateSettings({ notifications: { customSoundPath: selection } }).catch(
        () => undefined,
      );
    } finally {
      setIsChoosingSound(false);
    }
  }, [t, updateSettings]);

  const handleClearCustomSound = useCallback(() => {
    resetCustomNotificationSound();
    void updateSettings({ notifications: { customSoundPath: null } }).catch(() => undefined);
  }, [updateSettings]);

  const handleSendTestNotification = useCallback(() => {
    void sendTestNotification();
  }, [sendTestNotification]);

  const customSoundPath = settings.notifications.customSoundPath;
  const customSoundName = customSoundPath === null ? null : getFileName(customSoundPath);
  const isPermissionBusy = isRefreshing || requestingPermission !== null;
  const isSendingTestNotification = testNotificationState.status === "sending";
  const refreshIcon = useMemo(() => <ThemedRotateCw />, []);
  const refreshButton = useMemo(
    () => (
      <Button
        variant="ghost"
        size="sm"
        leftIcon={refreshIcon}
        onPress={handleRefreshPress}
        disabled={isPermissionBusy}
        accessibilityLabel={t("settings.notifications.refreshAccessibility")}
      >
        {isRefreshing ? t("settings.permissions.refreshing") : t("settings.permissions.refresh")}
      </Button>
    ),
    [handleRefreshPress, isPermissionBusy, isRefreshing, refreshIcon, t],
  );
  const permissionLabels = useMemo(
    () => ({
      granted: t("settings.permissions.actions.granted"),
      request: t("settings.permissions.actions.request"),
      requesting: t("settings.permissions.actions.requesting"),
    }),
    [t],
  );

  if (!isDesktopApp) {
    return null;
  }

  const notificationsGranted = snapshot?.notifications.state === "granted";

  return (
    <SettingsSection title={t("settings.notifications.title")} trailing={refreshButton}>
      <View style={settingsStyles.card}>
        <DesktopPermissionRow
          title={t("settings.notifications.permission")}
          status={snapshot?.notifications ?? null}
          isRequesting={requestingPermission === "notifications"}
          onRequest={handleRequestNotifications}
          labels={permissionLabels}
        />
        <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("settings.notifications.playSound")}</Text>
            <Text style={settingsStyles.rowHint}>{t("settings.notifications.playSoundHint")}</Text>
          </View>
          <Switch
            value={settings.notifications.playSound}
            onValueChange={handlePlaySoundChange}
            disabled={isSaving}
            accessibilityLabel={t("settings.notifications.playSound")}
            testID="desktop-notifications-play-sound-switch"
          />
        </View>
        {settings.notifications.playSound ? (
          <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>{t("settings.notifications.customSound")}</Text>
              <Text style={settingsStyles.rowHint} numberOfLines={1}>
                {customSoundName ?? t("settings.notifications.customSoundDefault")}
              </Text>
            </View>
            <View style={styles.customSoundActions}>
              {customSoundName ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onPress={handleClearCustomSound}
                  disabled={isSaving || isChoosingSound}
                  testID="desktop-notifications-custom-sound-clear"
                >
                  {t("settings.notifications.customSoundClear")}
                </Button>
              ) : null}
              <Button
                variant="outline"
                size="sm"
                onPress={handleChooseCustomSound}
                disabled={isSaving || isChoosingSound}
                testID="desktop-notifications-custom-sound-choose"
              >
                {t("settings.notifications.customSoundChoose")}
              </Button>
            </View>
          </View>
        ) : null}
        <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("settings.notifications.test")}</Text>
            <Text style={settingsStyles.rowHint}>
              {notificationsGranted
                ? t("settings.notifications.testHint")
                : t("settings.notifications.permissionRequired")}
            </Text>
          </View>
          <Button
            variant="outline"
            size="sm"
            onPress={handleSendTestNotification}
            disabled={!notificationsGranted || isPermissionBusy || isSendingTestNotification}
          >
            {isSendingTestNotification
              ? t("settings.notifications.sending")
              : t("settings.notifications.send")}
          </Button>
        </View>
      </View>
      {testNotificationState.status === "success" ? (
        <Alert
          variant="success"
          title={t("settings.notifications.sentTitle")}
          description={t("settings.notifications.sentDescription")}
          testID="desktop-notifications-test-success"
        />
      ) : null}
      {testNotificationState.status === "error" ? (
        <Alert
          variant="error"
          title={t("settings.notifications.sendFailedTitle")}
          description={testNotificationState.message}
          testID="desktop-notifications-test-error"
        />
      ) : null}
    </SettingsSection>
  );
}

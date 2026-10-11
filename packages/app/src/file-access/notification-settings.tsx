import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingsCard, SettingsRow, SettingsSection } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { sendOsNotification } from "@/utils/os-notifications";
import { Switch } from "@/components/ui/switch";
import { isNative } from "@/constants/platform";
import { isBackgroundPushConfigured } from "@/push-notifications";
import { useAppSettings } from "@/hooks/use-settings";
type Kind = "completed" | "failed" | "waiting" | "whileViewing";
const labels = {
  completed: "notifyCompleted",
  failed: "notifyFailed",
  waiting: "notifyWaiting",
  whileViewing: "notifyVisible",
} as const;
export function TaskNotificationSettings() {
  const { t } = useTranslation();
  const [testResult, setTestResult] = useState("");
  const testNotification = useCallback(() => {
    void sendOsNotification({
      title: t("fileAccess.notifyTestTitle"),
      body: t("fileAccess.notifyTestBody"),
    }).then((sent) => {
      setTestResult(t(sent ? "fileAccess.notifyTestSent" : "fileAccess.notifyTestFailed"));
      return sent;
    });
  }, [t]);
  return (
    <SettingsSection title={t("fileAccess.notificationsTitle")}>
      <SettingsCard>
        <NotificationRow kind="completed" />
        <NotificationRow kind="failed" />
        <NotificationRow kind="waiting" />
        <NotificationRow kind="whileViewing" />
        <SettingsRow label={t("fileAccess.notifyTest")} hint={testResult || undefined}>
          <Button variant="outline" onPress={testNotification}>
            {t("fileAccess.notifyTest")}
          </Button>
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  );
}
function NotificationRow({ kind }: { kind: Kind }) {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const change = useCallback(
    (value: boolean) => {
      void updateSettings((current) => ({
        taskNotifications: { ...current.taskNotifications, [kind]: value },
      }));
    },
    [updateSettings, kind],
  );
  return (
    <SettingsRow
      label={t(`fileAccess.${labels[kind]}`)}
      hint={
        kind === "completed"
          ? `${t("fileAccess.notifyHint")}${isNative && !isBackgroundPushConfigured() ? ` ${t("fileAccess.pushUnavailable")}` : ""}`
          : undefined
      }
    >
      <Switch
        value={settings.taskNotifications[kind]}
        onValueChange={change}
        accessibilityLabel={t(`fileAccess.${labels[kind]}`)}
      />
    </SettingsRow>
  );
}

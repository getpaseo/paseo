import { AppearanceText as Text } from "@/appearance/text";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { normalizeNotificationPreferences } from "@getpaseo/protocol/notification-preferences";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import {
  collectNotificationPlugins,
  hasConnectedHostMissingPushPreferences,
  setNotificationEventEnabled,
  setNotificationPluginMuted,
  type NotificationEventKey,
} from "@/components/settings/notifications-model";
import { Alert } from "@/components/ui/alert";
import { Switch } from "@/components/ui/switch";
import { isNative } from "@/constants/platform";
import { DesktopNotificationsSection } from "@/desktop/components/desktop-notifications-section";
import { useAppSettings } from "@/hooks/use-settings";
import { useConfiguredPluginsAcrossHosts } from "@/plugins/plugin-list";
import { useInstalledPlugins } from "@/plugins/registry";
import { useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { settingsStyles } from "@/styles/settings";

const EVENT_KEYS: readonly NotificationEventKey[] = [
  "agentPermission",
  "agentError",
  "agentFinished",
  "terminalNeedsInput",
  "terminalFinished",
];

interface EventSwitchRowProps {
  eventKey: NotificationEventKey;
  label: string;
  description: string;
  value: boolean;
  disabled: boolean;
  showBorder: boolean;
  onChange: (eventKey: NotificationEventKey, value: boolean) => void;
}

function EventSwitchRow({
  eventKey,
  label,
  description,
  value,
  disabled,
  showBorder,
  onChange,
}: EventSwitchRowProps) {
  const handleChange = useCallback(
    (nextValue: boolean) => {
      onChange(eventKey, nextValue);
    },
    [eventKey, onChange],
  );
  const rowStyle = useMemo(
    () => [settingsStyles.row, showBorder ? settingsStyles.rowBorder : null],
    [showBorder],
  );

  return (
    <View style={rowStyle}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{label}</Text>
        <Text style={settingsStyles.rowHint}>{description}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={handleChange}
        disabled={disabled}
        accessibilityLabel={label}
        testID={`notifications-event-${eventKey}-switch`}
      />
    </View>
  );
}

interface PluginSwitchRowProps {
  pluginId: string;
  label: string;
  muted: boolean;
  disabled: boolean;
  onToggleMuted: (pluginId: string, muted: boolean) => void;
}

function PluginSwitchRow({
  pluginId,
  label,
  muted,
  disabled,
  onToggleMuted,
}: PluginSwitchRowProps) {
  const handleChange = useCallback(
    (enabled: boolean) => {
      onToggleMuted(pluginId, !enabled);
    },
    [onToggleMuted, pluginId],
  );

  return (
    <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{label}</Text>
        {label !== pluginId ? <Text style={settingsStyles.rowHint}>{pluginId}</Text> : null}
      </View>
      <Switch
        value={!muted}
        onValueChange={handleChange}
        disabled={disabled}
        accessibilityLabel={label}
        testID={`notifications-plugin-switch-${pluginId}`}
      />
    </View>
  );
}

export function NotificationsSection() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const preferences = settings.notifications;
  const configuredPlugins = useConfiguredPluginsAcrossHosts();
  const installedPlugins = useInstalledPlugins();
  const hosts = useHosts();
  const sessions = useSessionStore((state) => state.sessions);

  const plugins = useMemo(
    () =>
      collectNotificationPlugins({
        configuredPlugins,
        installedPlugins,
        mutedPluginIds: preferences.plugins.muted,
      }),
    [configuredPlugins, installedPlugins, preferences.plugins.muted],
  );
  const mutedPluginIds = useMemo(
    () => new Set(preferences.plugins.muted),
    [preferences.plugins.muted],
  );
  const showLegacyHostHint = useMemo(
    () => isNative && hasConnectedHostMissingPushPreferences(hosts, sessions),
    [hosts, sessions],
  );

  const handleMasterEnabledChange = useCallback(
    (enabled: boolean) => {
      void updateSettings((current) => ({
        notifications: normalizeNotificationPreferences({
          ...current.notifications,
          enabled,
        }),
      }));
    },
    [updateSettings],
  );

  const handleEventChange = useCallback(
    (eventKey: NotificationEventKey, enabled: boolean) => {
      void updateSettings((current) => ({
        notifications: setNotificationEventEnabled(current.notifications, eventKey, enabled),
      }));
    },
    [updateSettings],
  );

  const handlePluginsEnabledChange = useCallback(
    (enabled: boolean) => {
      void updateSettings((current) => ({
        notifications: normalizeNotificationPreferences({
          ...current.notifications,
          plugins: {
            ...current.notifications.plugins,
            enabled,
          },
        }),
      }));
    },
    [updateSettings],
  );

  const handlePluginMutedChange = useCallback(
    (pluginId: string, muted: boolean) => {
      void updateSettings((current) => ({
        notifications: setNotificationPluginMuted(current.notifications, pluginId, muted),
      }));
    },
    [updateSettings],
  );

  const subCardStyle = useMemo(
    () => [settingsStyles.card, !preferences.enabled ? styles.disabledCard : null],
    [preferences.enabled],
  );
  const showEmptyPluginsRow = preferences.plugins.enabled && plugins.length === 0;
  const showPluginRows = preferences.plugins.enabled && plugins.length > 0;

  return (
    <View>
      <SettingsSection
        title={t("settings.notifications.title")}
        testID="notifications-master-section"
      >
        <View style={settingsStyles.card} testID="notifications-master-card">
          <View style={settingsStyles.row}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>
                {t("settings.notifications.enabled.label")}
              </Text>
              <Text style={settingsStyles.rowHint}>
                {preferences.enabled
                  ? t("settings.notifications.enabled.description")
                  : t("settings.notifications.enabled.pausedDescription")}
              </Text>
            </View>
            <Switch
              value={preferences.enabled}
              onValueChange={handleMasterEnabledChange}
              accessibilityLabel={t("settings.notifications.enabled.label")}
              testID="notifications-master-switch"
            />
          </View>
        </View>
        {showLegacyHostHint ? (
          <Alert
            size="sm"
            variant="info"
            title={t("settings.notifications.legacyHostTitle")}
            description={t("settings.notifications.legacyHostHint")}
            testID="notifications-legacy-host-alert"
          />
        ) : null}
      </SettingsSection>

      <SettingsSection
        title={t("settings.notifications.events.title")}
        testID="notifications-events-section"
      >
        <View style={subCardStyle} testID="notifications-events-card">
          {EVENT_KEYS.map((eventKey, index) => (
            <EventSwitchRow
              key={eventKey}
              eventKey={eventKey}
              label={t(`settings.notifications.events.${eventKey}.label`)}
              description={t(`settings.notifications.events.${eventKey}.description`)}
              value={preferences.events[eventKey]}
              disabled={!preferences.enabled}
              showBorder={index > 0}
              onChange={handleEventChange}
            />
          ))}
        </View>
      </SettingsSection>

      <SettingsSection
        title={t("settings.notifications.plugins.title")}
        testID="notifications-plugins-section"
      >
        <View style={subCardStyle} testID="notifications-plugins-card">
          <View style={settingsStyles.row}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>
                {t("settings.notifications.plugins.enabled.label")}
              </Text>
              <Text style={settingsStyles.rowHint}>
                {t("settings.notifications.plugins.enabled.description")}
              </Text>
            </View>
            <Switch
              value={preferences.plugins.enabled}
              onValueChange={handlePluginsEnabledChange}
              disabled={!preferences.enabled}
              accessibilityLabel={t("settings.notifications.plugins.enabled.label")}
              testID="notifications-plugins-enabled-switch"
            />
          </View>
          {showEmptyPluginsRow ? (
            <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
              <View style={settingsStyles.rowContent}>
                <Text style={settingsStyles.rowHint} testID="notifications-plugins-empty">
                  {t("settings.notifications.plugins.empty")}
                </Text>
              </View>
            </View>
          ) : null}
          {showPluginRows
            ? plugins.map((plugin) => (
                <PluginSwitchRow
                  key={plugin.id}
                  pluginId={plugin.id}
                  label={plugin.label}
                  muted={mutedPluginIds.has(plugin.id)}
                  disabled={!preferences.enabled}
                  onToggleMuted={handlePluginMutedChange}
                />
              ))
            : null}
        </View>
      </SettingsSection>

      <DesktopNotificationsSection />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  disabledCard: {
    opacity: theme.opacity[50],
  },
}));

import { useCallback, useEffect, useMemo, useState } from "react";
import { Platform, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import * as Notifications from "expo-notifications";
import * as Clipboard from "expo-clipboard";
import { Button } from "@/components/ui/button";
import { isNative } from "@/constants/platform";
import { getHostRuntimeStore, useHosts } from "@/runtime/host-runtime";
import { SettingsSection } from "@/screens/settings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { getExpoProjectId, redactExpoPushToken } from "@/utils/expo-project-id";

type PermissionState = "unknown" | "granted" | "denied" | "undetermined";

interface PushDiagnosticState {
  permission: PermissionState;
  projectId: string | null;
  token: string | null;
  tokenError: string | null;
  lastActionMessage: string | null;
  lastActionError: string | null;
  isBusy: boolean;
}

function mapPermissionStatus(status: Notifications.PermissionStatus): PermissionState {
  if (status === Notifications.PermissionStatus.GRANTED) {
    return "granted";
  }
  if (status === Notifications.PermissionStatus.DENIED) {
    return "denied";
  }
  return "undetermined";
}

async function ensureAndroidDefaultChannel(): Promise<void> {
  if (Platform.OS !== "android") {
    return;
  }
  await Notifications.setNotificationChannelAsync("default", {
    name: "default",
    importance: Notifications.AndroidImportance.DEFAULT,
  });
}

async function fetchExpoPushToken(
  projectId: string,
): Promise<{ token: string | null; error: string | null }> {
  try {
    await ensureAndroidDefaultChannel();
    const result = await Notifications.getExpoPushTokenAsync({ projectId });
    const token = typeof result.data === "string" && result.data.trim() ? result.data.trim() : null;
    if (!token) {
      return { token: null, error: "empty" };
    }
    return { token, error: null };
  } catch (error) {
    return {
      token: null,
      error: error instanceof Error ? error.message : "failed",
    };
  }
}

/**
 * Native-only notifications diagnostics: permission, Expo projectId, push token,
 * re-register with connected hosts, and a local OS notification test.
 */
export function MobileNotificationsSection() {
  const { t } = useTranslation();
  const hosts = useHosts();
  const [state, setState] = useState<PushDiagnosticState>({
    permission: "unknown",
    projectId: getExpoProjectId(),
    token: null,
    tokenError: null,
    lastActionMessage: null,
    lastActionError: null,
    isBusy: false,
  });

  const connectedHostCount = useMemo(() => {
    if (!isNative) {
      return 0;
    }
    const store = getHostRuntimeStore();
    return hosts.filter((host) => store.getSnapshot(host.serverId)?.connectionStatus === "online")
      .length;
  }, [hosts]);

  const refresh = useCallback(async () => {
    if (!isNative) {
      return;
    }
    setState((prev) => ({ ...prev, isBusy: true, lastActionError: null }));
    try {
      const projectId = getExpoProjectId();
      const permission = await Notifications.getPermissionsAsync();
      let token: string | null = null;
      let tokenError: string | null = null;

      if (permission.status === Notifications.PermissionStatus.GRANTED && !projectId) {
        tokenError = t("settings.permissions.mobile.errors.missingProjectId");
      } else if (permission.status === Notifications.PermissionStatus.GRANTED && projectId) {
        const fetched = await fetchExpoPushToken(projectId);
        token = fetched.token;
        if (fetched.error === "empty") {
          tokenError = t("settings.permissions.mobile.errors.tokenEmpty");
        } else if (fetched.error) {
          tokenError = fetched.error;
        }
      }

      setState((prev) => ({
        ...prev,
        permission: mapPermissionStatus(permission.status),
        projectId,
        token,
        tokenError,
        isBusy: false,
      }));
    } catch (error) {
      setState((prev) => ({
        ...prev,
        isBusy: false,
        lastActionError:
          error instanceof Error
            ? error.message
            : t("settings.permissions.mobile.errors.refreshFailed"),
      }));
    }
  }, [t]);

  useEffect(() => {
    if (!isNative) {
      return;
    }
    void refresh();
  }, [refresh]);

  const handleRequestPermission = useCallback(async () => {
    setState((prev) => ({ ...prev, isBusy: true, lastActionError: null, lastActionMessage: null }));
    try {
      const result = await Notifications.requestPermissionsAsync();
      const granted = result.status === Notifications.PermissionStatus.GRANTED;
      setState((prev) => ({
        ...prev,
        permission: mapPermissionStatus(result.status),
        isBusy: false,
        lastActionMessage: granted
          ? t("settings.permissions.mobile.messages.permissionGranted")
          : t("settings.permissions.mobile.messages.permissionDenied"),
      }));
      await refresh();
    } catch (error) {
      setState((prev) => ({
        ...prev,
        isBusy: false,
        lastActionError:
          error instanceof Error
            ? error.message
            : t("settings.permissions.mobile.errors.permissionFailed"),
      }));
    }
  }, [refresh, t]);

  const handleRegisterToken = useCallback(async () => {
    setState((prev) => ({ ...prev, isBusy: true, lastActionError: null, lastActionMessage: null }));
    try {
      const projectId = getExpoProjectId();
      if (!projectId) {
        setState((prev) => ({
          ...prev,
          isBusy: false,
          lastActionError: t("settings.permissions.mobile.errors.missingProjectId"),
        }));
        return;
      }
      const permission = await Notifications.getPermissionsAsync();
      if (permission.status !== Notifications.PermissionStatus.GRANTED) {
        setState((prev) => ({
          ...prev,
          isBusy: false,
          lastActionError: t("settings.permissions.mobile.errors.permissionRequired"),
        }));
        return;
      }
      const fetched = await fetchExpoPushToken(projectId);
      if (!fetched.token) {
        setState((prev) => ({
          ...prev,
          isBusy: false,
          lastActionError:
            fetched.error === "empty"
              ? t("settings.permissions.mobile.errors.tokenEmpty")
              : (fetched.error ?? t("settings.permissions.mobile.errors.tokenFailed")),
        }));
        return;
      }

      const store = getHostRuntimeStore();
      let registered = 0;
      for (const host of hosts) {
        const snapshot = store.getSnapshot(host.serverId);
        if (snapshot?.connectionStatus !== "online" || !snapshot.client) {
          continue;
        }
        snapshot.client.registerPushToken(fetched.token);
        registered += 1;
      }

      setState((prev) => ({
        ...prev,
        token: fetched.token,
        tokenError: null,
        isBusy: false,
        lastActionMessage:
          registered > 0
            ? t("settings.permissions.mobile.messages.registered", { count: registered })
            : t("settings.permissions.mobile.messages.tokenReadyNoHosts"),
      }));
    } catch (error) {
      setState((prev) => ({
        ...prev,
        isBusy: false,
        lastActionError:
          error instanceof Error
            ? error.message
            : t("settings.permissions.mobile.errors.registerFailed"),
      }));
    }
  }, [hosts, t]);

  const handleTestLocalNotification = useCallback(async () => {
    setState((prev) => ({ ...prev, isBusy: true, lastActionError: null, lastActionMessage: null }));
    try {
      const permission = await Notifications.getPermissionsAsync();
      let status = permission.status;
      if (status !== Notifications.PermissionStatus.GRANTED) {
        const requested = await Notifications.requestPermissionsAsync();
        status = requested.status;
        if (status !== Notifications.PermissionStatus.GRANTED) {
          setState((prev) => ({
            ...prev,
            isBusy: false,
            permission: mapPermissionStatus(status),
            lastActionError: t("settings.permissions.mobile.errors.permissionRequired"),
          }));
          return;
        }
      }
      await ensureAndroidDefaultChannel();
      await Notifications.scheduleNotificationAsync({
        content: {
          title: t("settings.permissions.mobile.testLocal.title"),
          body: t("settings.permissions.mobile.testLocal.body"),
        },
        trigger: null,
      });
      setState((prev) => ({
        ...prev,
        isBusy: false,
        permission: mapPermissionStatus(status),
        lastActionMessage: t("settings.permissions.mobile.messages.localTestSent"),
      }));
    } catch (error) {
      setState((prev) => ({
        ...prev,
        isBusy: false,
        lastActionError:
          error instanceof Error
            ? error.message
            : t("settings.permissions.mobile.errors.localTestFailed"),
      }));
    }
  }, [t]);

  const handleCopyToken = useCallback(async () => {
    if (!state.token) {
      return;
    }
    try {
      await Clipboard.setStringAsync(state.token);
      setState((prev) => ({
        ...prev,
        lastActionMessage: t("settings.permissions.mobile.messages.tokenCopied"),
        lastActionError: null,
      }));
    } catch {
      setState((prev) => ({
        ...prev,
        lastActionError: t("settings.permissions.mobile.errors.copyFailed"),
      }));
    }
  }, [state.token, t]);

  const onPressRequestPermission = useCallback(() => {
    void handleRequestPermission();
  }, [handleRequestPermission]);
  const onPressCopyToken = useCallback(() => {
    void handleCopyToken();
  }, [handleCopyToken]);
  const onPressRegister = useCallback(() => {
    void handleRegisterToken();
  }, [handleRegisterToken]);
  const onPressTestLocal = useCallback(() => {
    void handleTestLocalNotification();
  }, [handleTestLocalNotification]);
  const onPressRefresh = useCallback(() => {
    void refresh();
  }, [refresh]);

  if (!isNative) {
    return null;
  }

  const permissionLabel = t(`settings.permissions.mobile.permission.${state.permission}`);
  const projectIdLabel = state.projectId
    ? state.projectId
    : t("settings.permissions.mobile.projectIdMissing");
  const tokenLabel = state.token
    ? redactExpoPushToken(state.token)
    : (state.tokenError ?? t("settings.permissions.mobile.tokenMissing"));

  return (
    <SettingsSection title={t("settings.permissions.mobile.title")}>
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>
              {t("settings.permissions.mobile.permission.label")}
            </Text>
            <Text style={settingsStyles.rowHint}>{permissionLabel}</Text>
          </View>
          <Button
            variant="secondary"
            size="sm"
            onPress={onPressRequestPermission}
            disabled={state.isBusy || state.permission === "granted"}
            testID="mobile-notifications-request-permission"
          >
            {t("settings.permissions.mobile.permission.request")}
          </Button>
        </View>

        <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>
              {t("settings.permissions.mobile.projectId.label")}
            </Text>
            <Text style={settingsStyles.rowHint} numberOfLines={2}>
              {projectIdLabel}
            </Text>
          </View>
        </View>

        <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>
              {t("settings.permissions.mobile.token.label")}
            </Text>
            <Text style={settingsStyles.rowHint} numberOfLines={2}>
              {tokenLabel}
            </Text>
            <Text style={settingsStyles.rowHint}>
              {t("settings.permissions.mobile.hosts.connected", { count: connectedHostCount })}
            </Text>
          </View>
          <View style={styles.actionColumn}>
            <Button
              variant="secondary"
              size="sm"
              onPress={onPressCopyToken}
              disabled={state.isBusy || !state.token}
              testID="mobile-notifications-copy-token"
            >
              {t("settings.permissions.mobile.token.copy")}
            </Button>
          </View>
        </View>

        <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>
              {t("settings.permissions.mobile.actions.label")}
            </Text>
            <Text style={settingsStyles.rowHint}>
              {t("settings.permissions.mobile.actions.description")}
            </Text>
            {state.lastActionMessage ? (
              <Text style={styles.feedbackMessage}>{state.lastActionMessage}</Text>
            ) : null}
            {state.lastActionError ? (
              <Text style={styles.feedbackError}>{state.lastActionError}</Text>
            ) : null}
          </View>
          <View style={styles.actionColumn}>
            <Button
              variant="secondary"
              size="sm"
              onPress={onPressRegister}
              disabled={state.isBusy}
              testID="mobile-notifications-register"
            >
              {t("settings.permissions.mobile.actions.register")}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onPress={onPressTestLocal}
              disabled={state.isBusy}
              testID="mobile-notifications-test-local"
            >
              {t("settings.permissions.mobile.actions.testLocal")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onPress={onPressRefresh}
              disabled={state.isBusy}
              testID="mobile-notifications-refresh"
            >
              {t("settings.permissions.refresh")}
            </Button>
          </View>
        </View>
      </View>
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  actionColumn: {
    gap: theme.spacing[2],
    alignItems: "flex-end",
  },
  feedbackMessage: {
    fontSize: theme.fontSize.xs,
    marginTop: theme.spacing[1],
    color: theme.colors.foregroundMuted,
  },
  feedbackError: {
    fontSize: theme.fontSize.xs,
    marginTop: theme.spacing[1],
    color: theme.colors.destructive,
  },
}));

import { useAddHost } from "@/hosts/add-host";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View, ScrollView } from "react-native";
import { useRouter } from "expo-router";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import {
  QrCode,
  Link2,
  ClipboardPaste,
  ExternalLink,
  Settings,
  Terminal,
} from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { getHostRuntimeStore, isHostRuntimeConnected, useHosts } from "@/runtime/host-runtime";
import { Button } from "@/components/ui/button";
import { resolveAppVersion } from "@/utils/app-version";
import { formatVersionWithPrefix } from "@/desktop/updates/desktop-updates";
import { buildOpenProjectRoute } from "@/utils/host-routes";
import { PaseoLogo } from "@/components/icons/paseo-logo";
import { openExternalUrl } from "@/utils/open-external-url";
import { isFdroidBuild } from "@/constants/build-profile";
import { isWeb, isNative } from "@/constants/platform";
import { isElectronRuntime } from "@/desktop/host";

interface WelcomeAction {
  key: "scan-qr" | "direct-connection" | "remote-ssh" | "paste-pairing-link";
  label: string;
  testID: string;
  primary: boolean;
  icon: typeof QrCode;
  onPress: () => void;
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  scrollView: {
    flex: 1,
  },
  container: {
    flexGrow: 1,
    padding: theme.spacing[6],
    paddingBottom: 0,
    alignItems: "center",
  },
  content: {
    width: "100%",
    flexGrow: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    textAlign: "center",
  },
  subtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  copyBlock: {
    alignItems: "center",
    gap: theme.spacing[2],
    marginBottom: theme.spacing[12],
  },
  actions: {
    width: "100%",
    maxWidth: 420,
    gap: theme.spacing[3],
  },
  actionButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[4],
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  actionButtonPrimary: {
    backgroundColor: theme.colors.accent,
    borderColor: theme.colors.accent,
  },
  actionText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  actionTextPrimary: {
    color: theme.colors.accentForeground,
  },
  setupLink: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  setupLinkText: {
    color: theme.colors.accent,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  versionLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
    marginTop: theme.spacing[6],
  },
  settingsButton: {
    alignSelf: "center",
    marginTop: theme.spacing[6],
  },
}));

function useAnyHostOnline(serverIds: string[]): string | null {
  const runtime = getHostRuntimeStore();
  return useSyncExternalStore(
    (onStoreChange) => runtime.subscribeAll(onStoreChange),
    () => {
      let firstOnlineServerId: string | null = null;
      let firstOnlineAt: string | null = null;
      for (const serverId of serverIds) {
        const snapshot = runtime.getSnapshot(serverId);
        const lastOnlineAt = snapshot?.lastOnlineAt ?? null;
        if (!isHostRuntimeConnected(snapshot) || !lastOnlineAt) {
          continue;
        }
        if (!firstOnlineAt || lastOnlineAt < firstOnlineAt) {
          firstOnlineAt = lastOnlineAt;
          firstOnlineServerId = serverId;
        }
      }
      return firstOnlineServerId;
    },
    () => {
      let firstOnlineServerId: string | null = null;
      let firstOnlineAt: string | null = null;
      for (const serverId of serverIds) {
        const snapshot = runtime.getSnapshot(serverId);
        const lastOnlineAt = snapshot?.lastOnlineAt ?? null;
        if (!isHostRuntimeConnected(snapshot) || !lastOnlineAt) {
          continue;
        }
        if (!firstOnlineAt || lastOnlineAt < firstOnlineAt) {
          firstOnlineAt = lastOnlineAt;
          firstOnlineServerId = serverId;
        }
      }
      return firstOnlineServerId;
    },
  );
}

export function WelcomeScreen() {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const appVersion = resolveAppVersion();
  const appVersionText = formatVersionWithPrefix(appVersion);
  const hosts = useHosts();
  const anyOnlineServerId = useAnyHostOnline(hosts.map((h) => h.serverId));

  useEffect(() => {
    if (!anyOnlineServerId) return;
    router.replace(buildOpenProjectRoute());
  }, [anyOnlineServerId, router]);

  const finishOnboarding = useCallback(() => {
    router.replace(buildOpenProjectRoute());
  }, [router]);

  const handleOpenPaseoSite = useCallback(() => {
    void openExternalUrl("https://paseo.sh");
  }, []);

  const handleOpenSettings = useCallback(() => {
    router.push("/settings");
  }, [router]);

  const handleOpenDirect = useAddHost({ method: "direct", onAdded: finishOnboarding });
  const handleOpenRemoteSsh = useAddHost({ method: "ssh", onAdded: finishOnboarding });
  const handleOpenPasteLink = useAddHost({ method: "link", onAdded: finishOnboarding });
  const handleScanQr = useAddHost({ method: "scan", onAdded: finishOnboarding });

  const actions: WelcomeAction[] =
    isWeb || isFdroidBuild
      ? [
          {
            key: "direct-connection",
            label: t("pairing.connectionMethods.direct.title"),
            testID: "welcome-direct-connection",
            primary: true,
            icon: Link2,
            onPress: handleOpenDirect,
          },
          {
            key: "paste-pairing-link",
            label: t("pairing.connectionMethods.pasteLink.title"),
            testID: "welcome-paste-pairing-link",
            primary: false,
            icon: ClipboardPaste,
            onPress: handleOpenPasteLink,
          },
        ]
      : [
          {
            key: "scan-qr",
            label: t("pairing.connectionMethods.scanQr.title"),
            testID: "welcome-scan-qr",
            primary: true,
            icon: QrCode,
            onPress: handleScanQr,
          },
          {
            key: "direct-connection",
            label: t("pairing.connectionMethods.direct.title"),
            testID: "welcome-direct-connection",
            primary: false,
            icon: Link2,
            onPress: handleOpenDirect,
          },
          {
            key: "paste-pairing-link",
            label: t("pairing.connectionMethods.pasteLink.title"),
            testID: "welcome-paste-pairing-link",
            primary: false,
            icon: ClipboardPaste,
            onPress: handleOpenPasteLink,
          },
        ];

  if (isElectronRuntime()) {
    actions.splice(1, 0, {
      key: "remote-ssh",
      label: t("pairing.connectionMethods.remoteSsh.title"),
      testID: "welcome-remote-ssh",
      primary: false,
      icon: Terminal,
      onPress: handleOpenRemoteSsh,
    });
  }

  const scrollContentContainerStyle = useMemo(
    () => [styles.container, { paddingBottom: theme.spacing[6] + insets.bottom }],
    [theme.spacing, insets.bottom],
  );

  return (
    <View style={styles.root}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={scrollContentContainerStyle}
        showsVerticalScrollIndicator={false}
        testID="welcome-screen"
      >
        <View style={styles.content}>
          <PaseoLogo size={96} />
          <View style={styles.copyBlock}>
            <Text style={styles.title}>{t("onboarding.title")}</Text>
            <Text style={styles.subtitle}>{t("onboarding.subtitle")}</Text>
            {isNative ? (
              <Pressable style={styles.setupLink} onPress={handleOpenPaseoSite}>
                <Text style={styles.setupLinkText}>paseo.sh</Text>
                <ExternalLink size={14} color={theme.colors.accent} />
              </Pressable>
            ) : null}
          </View>

          <View style={styles.actions}>
            {actions.map((action) => (
              <WelcomeActionButton key={action.key} action={action} />
            ))}
          </View>

          <Button
            variant="ghost"
            leftIcon={Settings}
            onPress={handleOpenSettings}
            style={styles.settingsButton}
            testID="welcome-open-settings"
          >
            {t("onboarding.actions.settings")}
          </Button>
        </View>
        <Text style={styles.versionLabel}>{appVersionText}</Text>
      </ScrollView>
    </View>
  );
}

interface WelcomeActionButtonProps {
  action: WelcomeAction;
}

function WelcomeActionButton({ action }: WelcomeActionButtonProps) {
  const { theme } = useUnistyles();
  const Icon = action.icon;
  const buttonStyle = useMemo(
    () => [styles.actionButton, action.primary ? styles.actionButtonPrimary : null],
    [action.primary],
  );
  const textStyle = useMemo(
    () => [styles.actionText, action.primary ? styles.actionTextPrimary : null],
    [action.primary],
  );
  return (
    <Pressable style={buttonStyle} onPress={action.onPress} testID={action.testID}>
      <Icon
        size={18}
        color={action.primary ? theme.colors.accentForeground : theme.colors.foreground}
      />
      <Text style={textStyle}>{action.label}</Text>
    </Pressable>
  );
}

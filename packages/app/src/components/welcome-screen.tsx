import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Pressable, Text, View, Platform, ScrollView } from "react-native";
import { useRouter } from "expo-router";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { QrCode, Link2, ClipboardPaste, ExternalLink } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { HostProfile } from "@/types/host-connection";
import {
  getHostRuntimeStore,
  isHostRuntimeConnected,
  useHostMutations,
  useHostRuntimeSnapshot,
  useHosts,
} from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { AddHostModal } from "./add-host-modal";
import { PairLinkModal } from "./pair-link-modal";
import { NameHostModal } from "./name-host-modal";
import { resolveAppVersion } from "@/utils/app-version";
import { formatVersionWithPrefix } from "@/desktop/updates/desktop-updates";
import { buildHostRootRoute } from "@/utils/host-routes";
import { PaseoLogo } from "@/components/icons/paseo-logo";
import { openExternalUrl } from "@/utils/open-external-url";

type WelcomeAction = {
  key: "scan-qr" | "direct-connection" | "paste-pairing-link";
  label: string;
  testID: string;
  primary: boolean;
  icon: typeof QrCode;
  onPress: () => void;
};

const styles = StyleSheet.create((theme) => ({
  container: {
    flexGrow: 1,
    backgroundColor: theme.colors.surface0,
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
    fontSize: theme.fontSize.xl,
    fontWeight: theme.fontWeight.medium,
    marginBottom: theme.spacing[3],
    textAlign: "center",
  },
  subtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
    marginBottom: theme.spacing[8],
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
  hostList: {
    width: "100%",
    maxWidth: 420,
    marginTop: theme.spacing[6],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingTop: theme.spacing[4],
    gap: theme.spacing[2],
  },
  hostRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  hostLabel: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  hostStatus: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  hostStatusError: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
  },
  setupHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
    marginBottom: theme.spacing[6],
    lineHeight: theme.fontSize.sm * 1.5,
  },
  setupLink: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    marginBottom: theme.spacing[6],
  },
  setupLinkText: {
    color: theme.colors.accent,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  versionLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    textAlign: "center",
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

function HostStatusRow({ serverId, label }: { serverId: string; label: string }) {
  const { theme } = useUnistyles();
  const snapshot = useHostRuntimeSnapshot(serverId);
  const status = snapshot?.connectionStatus ?? "connecting";
  const lastError = snapshot?.lastError ?? null;

  let dotColor: string;
  let statusText: string;
  let isError = false;

  switch (status) {
    case "online":
      dotColor = theme.colors.success;
      statusText = "Online";
      break;
    case "connecting":
    case "idle":
      dotColor = theme.colors.foregroundMuted;
      statusText = "Connecting…";
      break;
    case "offline":
      dotColor = theme.colors.foregroundMuted;
      statusText = "Offline";
      break;
    case "error":
      dotColor = theme.colors.destructive;
      statusText = lastError ? lastError.slice(0, 40) : "Connection error";
      isError = true;
      break;
  }

  return (
    <View style={styles.hostRow}>
      <View style={[styles.statusDot, { backgroundColor: dotColor }]} />
      <Text style={styles.hostLabel} numberOfLines={1}>
        {label}
      </Text>
      <Text style={isError ? styles.hostStatusError : styles.hostStatus} numberOfLines={1}>
        {statusText}
      </Text>
    </View>
  );
}

export interface WelcomeScreenProps {
  onHostAdded?: (profile: HostProfile) => void;
}

export function WelcomeScreen({ onHostAdded }: WelcomeScreenProps) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { renameHost } = useHostMutations();
  const appVersion = resolveAppVersion();
  const appVersionText = formatVersionWithPrefix(appVersion);
  const [isDirectOpen, setIsDirectOpen] = useState(false);
  const [isPasteLinkOpen, setIsPasteLinkOpen] = useState(false);
  const [pendingNameHost, setPendingNameHost] = useState<{
    serverId: string;
    hostname: string | null;
  } | null>(null);
  const [pendingRedirectServerId, setPendingRedirectServerId] = useState<string | null>(null);
  const hosts = useHosts();
  const anyOnlineServerId = useAnyHostOnline(hosts.map((h) => h.serverId));
  const pendingNameHostname = useSessionStore(
    useCallback(
      (state) => {
        if (!pendingNameHost) return null;
        return (
          state.sessions[pendingNameHost.serverId]?.serverInfo?.hostname ??
          pendingNameHost.hostname ??
          null
        );
      },
      [pendingNameHost],
    ),
  );

  useEffect(() => {
    if (!anyOnlineServerId) {
      return;
    }
    if (pendingNameHost) {
      return;
    }
    router.replace(buildHostRootRoute(anyOnlineServerId));
  }, [anyOnlineServerId, pendingNameHost, router]);

  const finishOnboarding = useCallback(
    (serverId: string) => {
      router.replace(buildHostRootRoute(serverId));
    },
    [router],
  );

  const actions: WelcomeAction[] =
    Platform.OS === "web"
      ? [
          {
            key: "direct-connection",
            label: "Direct connection",
            testID: "welcome-direct-connection",
            primary: true,
            icon: Link2,
            onPress: () => setIsDirectOpen(true),
          },
          {
            key: "paste-pairing-link",
            label: "Paste pairing link",
            testID: "welcome-paste-pairing-link",
            primary: false,
            icon: ClipboardPaste,
            onPress: () => setIsPasteLinkOpen(true),
          },
        ]
      : [
          {
            key: "scan-qr",
            label: "Scan QR code",
            testID: "welcome-scan-qr",
            primary: true,
            icon: QrCode,
            onPress: () => router.push("/pair-scan?source=onboarding"),
          },
          {
            key: "direct-connection",
            label: "Direct connection",
            testID: "welcome-direct-connection",
            primary: false,
            icon: Link2,
            onPress: () => setIsDirectOpen(true),
          },
          {
            key: "paste-pairing-link",
            label: "Paste pairing link",
            testID: "welcome-paste-pairing-link",
            primary: false,
            icon: ClipboardPaste,
            onPress: () => setIsPasteLinkOpen(true),
          },
        ];

  const showHostList = hosts.length > 0 && !anyOnlineServerId;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={[
        styles.container,
        { paddingBottom: theme.spacing[6] + insets.bottom },
      ]}
      showsVerticalScrollIndicator={false}
      testID="welcome-screen"
    >
      <View style={styles.content}>
        <PaseoLogo size={96} />
        <Text style={styles.title}>Welcome to Paseo</Text>
        <Text style={styles.subtitle}>
          {showHostList ? "Connecting to your hosts…" : "Connect to your host to start"}
        </Text>

        {!showHostList && Platform.OS !== "web" && (
          <>
            <Text style={styles.setupHint}>
              You need the Paseo desktop app or server running on your computer first.
            </Text>
            <Pressable
              style={styles.setupLink}
              onPress={() => openExternalUrl("https://paseo.sh")}
            >
              <Text style={styles.setupLinkText}>Get started at paseo.sh</Text>
              <ExternalLink size={14} color={theme.colors.accent} />
            </Pressable>
          </>
        )}

        <View style={styles.actions}>
          {actions.map((action) => {
            const Icon = action.icon;
            return (
              <Pressable
                key={action.key}
                style={[styles.actionButton, action.primary ? styles.actionButtonPrimary : null]}
                onPress={action.onPress}
                testID={action.testID}
              >
                <Icon
                  size={18}
                  color={action.primary ? theme.colors.accentForeground : theme.colors.foreground}
                />
                <Text style={[styles.actionText, action.primary ? styles.actionTextPrimary : null]}>
                  {action.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {showHostList && (
          <View style={styles.hostList}>
            {hosts.map((host) => (
              <HostStatusRow key={host.serverId} serverId={host.serverId} label={host.label} />
            ))}
          </View>
        )}
      </View>
      <Text style={styles.versionLabel}>{appVersionText}</Text>

      <AddHostModal
        visible={isDirectOpen}
        onClose={() => setIsDirectOpen(false)}
        onSaved={({ profile, serverId, hostname, isNewHost }) => {
          onHostAdded?.(profile);
          setPendingRedirectServerId(serverId);
          if (isNewHost) {
            setPendingNameHost({ serverId, hostname });
            return;
          }
          finishOnboarding(serverId);
        }}
      />

      <PairLinkModal
        visible={isPasteLinkOpen}
        onClose={() => setIsPasteLinkOpen(false)}
        onSaved={({ profile, serverId, hostname, isNewHost }) => {
          onHostAdded?.(profile);
          setPendingRedirectServerId(serverId);
          if (isNewHost) {
            setPendingNameHost({ serverId, hostname });
            return;
          }
          finishOnboarding(serverId);
        }}
      />

      {pendingNameHost && pendingRedirectServerId ? (
        <NameHostModal
          visible
          serverId={pendingNameHost.serverId}
          hostname={pendingNameHostname}
          onSkip={() => {
            const serverId = pendingRedirectServerId;
            setPendingNameHost(null);
            setPendingRedirectServerId(null);
            finishOnboarding(serverId);
          }}
          onSave={(label) => {
            const serverId = pendingRedirectServerId;
            void renameHost(pendingNameHost.serverId, label).finally(() => {
              setPendingNameHost(null);
              setPendingRedirectServerId(null);
              finishOnboarding(serverId);
            });
          }}
        />
      ) : null}
    </ScrollView>
  );
}

import { useCallback, useState } from "react";
import { Image, Pressable, Text, View, Platform, ScrollView } from "react-native";
import { useRouter } from "expo-router";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { QrCode, Link2, ClipboardPaste } from "lucide-react-native";
import type { HostProfile } from "@/contexts/daemon-registry-context";
import { useDaemonRegistry } from "@/contexts/daemon-registry-context";
import { useSessionStore } from "@/stores/session-store";
import { AddHostModal } from "./add-host-modal";
import { PairLinkModal } from "./pair-link-modal";
import { NameHostModal } from "./name-host-modal";

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
    padding: theme.spacing[6],
    justifyContent: "center",
    alignItems: "center",
  },
  logo: {
    width: 96,
    height: 96,
    marginBottom: theme.spacing[6],
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
    backgroundColor: theme.colors.palette.blue[500],
    borderColor: theme.colors.palette.blue[500],
  },
  actionText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  actionTextPrimary: {
    color: theme.colors.palette.white,
  },
}));

export interface WelcomeScreenProps {
  onHostAdded?: (profile: HostProfile) => void;
}

export function WelcomeScreen({ onHostAdded }: WelcomeScreenProps) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const { updateHost } = useDaemonRegistry();
  const [isDirectOpen, setIsDirectOpen] = useState(false);
  const [isPasteLinkOpen, setIsPasteLinkOpen] = useState(false);
  const [pendingNameHost, setPendingNameHost] = useState<{ serverId: string; hostname: string | null } | null>(null);
  const [pendingRedirectServerId, setPendingRedirectServerId] = useState<string | null>(null);
  const pendingNameHostname = useSessionStore(
    useCallback(
      (state) => {
        if (!pendingNameHost) return null;
        return state.sessions[pendingNameHost.serverId]?.serverInfo?.hostname ?? pendingNameHost.hostname ?? null;
      },
      [pendingNameHost]
    )
  );

  const finishOnboarding = useCallback(
    (serverId: string) => {
      router.replace({ pathname: "/", params: { serverId } });
    },
    [router]
  );

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={styles.container}
      showsVerticalScrollIndicator={false}
      testID="welcome-screen"
    >
      <Image
        source={require("../../assets/images/icon.png")}
        style={styles.logo}
        resizeMode="contain"
      />
      <Text style={styles.title}>Welcome to Paseo</Text>
      <Text style={styles.subtitle}>Add a host to start.</Text>

      <View style={styles.actions}>
        <Pressable
          style={[styles.actionButton, styles.actionButtonPrimary]}
          onPress={() => setIsDirectOpen(true)}
          testID="welcome-direct-connection"
        >
          <Link2 size={18} color={theme.colors.palette.white} />
          <Text style={[styles.actionText, styles.actionTextPrimary]}>Direct connection</Text>
        </Pressable>

        <Pressable
          style={styles.actionButton}
          onPress={() => setIsPasteLinkOpen(true)}
          testID="welcome-paste-pairing-link"
        >
          <ClipboardPaste size={18} color={theme.colors.foreground} />
          <Text style={styles.actionText}>Paste pairing link</Text>
        </Pressable>

        {Platform.OS !== "web" ? (
          <Pressable
            style={styles.actionButton}
            onPress={() => router.push("/pair-scan?source=onboarding")}
            testID="welcome-scan-qr"
          >
            <QrCode size={18} color={theme.colors.foreground} />
            <Text style={styles.actionText}>Scan QR code</Text>
          </Pressable>
        ) : null}
      </View>

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
            void updateHost(pendingNameHost.serverId, { label }).finally(() => {
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
